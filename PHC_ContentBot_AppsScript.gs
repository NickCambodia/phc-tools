// ═══════════════════════════════════════════════════════════════
//  PHC Content Bot — Listing detection + multi-language distribution
//
//  Flow: forward a listing post (from e.g. t.me/REAKHchinese) to
//  this bot in your private chat → bot detects it's a listing
//  (#ForSale / #ForRent), extracts the fields, rebuilds it in PHC's
//  template for EN/JP/DE (photo carried over, JP/DE translated via
//  Apps Script's built-in free translator) → sends all 3 to you for
//  Approve/Reject → on approve, posts to that language's channel.
//
//  You can also still add a row manually to the Queue sheet
//  (language + content) and use "Send New Content for Review" from
//  the menu — both paths share the same review/approval mechanism.
//
//  Uses POLLING (checkForUpdates, on a 1-minute trigger), not a
//  webhook — Google Apps Script Web App URLs always 302-redirect to
//  script.googleusercontent.com to serve their response, and
//  Telegram's webhook caller does not follow redirects. Polling
//  sidesteps that entirely since it's Apps Script calling Telegram,
//  not the other way around.
//
//  HOW TO DEPLOY:
//  1. Open the "PHC Content Queue" Google Sheet
//  2. Extensions → Apps Script → paste this entire file
//  3. Project Settings (⚙) → Script Properties → add:
//     BOT_TOKEN = <your bot token from BotFather>
//  4. Run initializeAll() once (creates the Queue tab)
//  5. Run migrateQueueSchema() once (adds the photoFileId column —
//     safe to run even on a brand-new sheet)
//  6. Run installTriggers() once (starts checking every minute —
//     no Web App deployment needed for this part)
// ═══════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────
const REVIEWER_CHAT_ID = '353195979'; // Nick's personal Telegram chat — approval requests go here

// Map each language to its public channel's Chat ID.
// EN points at t.me/PHC_EN — a separate pilot channel, NOT the live
// client-facing t.me/PropertyHubCambodia. Swap this to PropertyHubCambodia's
// real Chat ID once ready to go live for real.
const LANGUAGE_CHANNELS = {
  EN: '-1004394035989', // t.me/PHC_EN (pilot — not the live PropertyHubCambodia channel)
  JP: '-1003986315402', // t.me/PHC_JP (renamed from the old pilot TEST channel)
  RU: '-1003704439031', // t.me/PHC_RU
  DE: '-1004434464190', // t.me/PHC_DE
};

// Contact block appended to every listing, per PHC's ChatGPT listing prompt.
// Never carry over a source agent's own contact info. Includes the main
// channel link as plain text since getContactKeyboard()'s "More Property"
// button now points to the website, not the Telegram channel — this is the
// only place the channel link still shows up.
const CONTACT_STANDARD = '📞 011 666 952\n📱 t.me/PropertyHubCambodia';

// Removes a trailing contact block (phone / t.me links / separator line)
// from the END of otherwise-arbitrary text, e.g. Nick's own channel posts,
// which always end with their own "📞 ...\n🏠 t.me/...\n📱 t.me/..." block.
// Used so CONTACT_STANDARD can fully replace it rather than being appended
// alongside it. Walks backward from the last line, trimming as long as each
// line is blank, a dash/em-dash separator, or a contact line (starts with a
// contact emoji, or contains a t.me/ link) — stops at the first real content
// line so listing details are never touched.
function stripTrailingContactBlock(text) {
  const lines = text.split('\n');
  const sepRe = /^[―—_\-⎯]{3,}$/;
  const contactStartRe = /^[📞📱☎✆🏠📧✉]/u; // 'u' flag required — without it, astral-plane emoji classes match on raw surrogate halves and false-positive on unrelated emoji sharing the same high surrogate
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line === '' || sepRe.test(line) || contactStartRe.test(line) || line.indexOf('t.me/') !== -1) {
      end--;
    } else {
      break;
    }
  }
  return lines.slice(0, end).join('\n').replace(/\s+$/, '');
}

// Each channel's "Contact Us" opens a direct Telegram chat with the person
// in charge of that audience — not a shared WhatsApp line — so replies come
// from the right staff member with no extra bot hop for the client.
const CHANNEL_CONTACT_PERSON = {
  EN: 'Monika_PHC',
  JP: 'Nick_REAKH',
  RU: 'Monika_PHC',
  DE: 'RAZ_360',
};

// 2 buttons for every listing — "Contact Us" routes to the channel's owner
// on Telegram, "More Property" links to the website. channelTag (e.g.
// 'EN'/'JP'/'RU'/'DE') selects who "Contact Us" points to; falls back to
// Monika if an unrecognized/missing tag is passed.
function getContactKeyboard(channelTag) {
  const contactUsername = CHANNEL_CONTACT_PERSON[channelTag] || CHANNEL_CONTACT_PERSON.EN;
  return { inline_keyboard: [[
    { text: '📱 Contact Us', url: 'https://t.me/' + contactUsername },
    { text: '🌐 More Property', url: 'https://propertyhubcambodia.com' },
  ]] };
}

const SHEET_NAME = 'Queue';
const HEADERS = ['id', 'createdAt', 'language', 'content', 'status', 'reviewMsgId', 'postedMsgId', 'postedAt', 'photoFileId', 'listingType', 'entities'];

// ── Polling — checks Telegram for new messages/button taps every minute ─

function checkForUpdates() {
  // One run at a time: a fast-mode run can last most of a minute, and two pollers
  // would otherwise handle the same button tap twice.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(3000)) { Logger.log('checkForUpdates: previous run still busy, skipping'); return; }
  try {
    pollTelegramOnce(0);
    // FAST MODE: while a website draft is in progress, keep listening (Telegram "long polling") so taps are
    // answered in seconds, not at the next 1-minute tick. One run covers the whole session (up to 4 minutes,
    // inside Apps Script's 6 minute limit); the per-user lock makes the 1-minute triggers skip meanwhile, and
    // the next trigger carries on if the session is still open. The session ends 10 minutes after the last tap.
    const stopAt = Date.now() + UNIT_FAST_MODE_MS;
    while (isUnitSessionActive() && Date.now() < stopAt) pollTelegramOnce(5);
  } finally {
    lock.releaseLock();
  }
}

function pollTelegramOnce(timeoutSeconds) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const props = PropertiesService.getScriptProperties();
  const lastOffset = Number(props.getProperty('LAST_UPDATE_OFFSET') || '0');

  // allowed_updates must be listed explicitly to receive message_reaction_count —
  // Telegram omits reaction updates by default unless a bot opts in. Specifying
  // this list REPLACES the default set, so every update type the bot relies on
  // elsewhere (message, callback_query, channel_post) has to be included too.
  const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'callback_query', 'channel_post', 'message_reaction_count']));
  const resp = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + token + '/getUpdates?offset=' + (lastOffset + 1) + '&timeout=' + timeoutSeconds + '&allowed_updates=' + allowedUpdates,
    { muteHttpExceptions: true }
  );
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) { Logger.log('getUpdates failed: ' + resp.getContentText()); return; }
  if (timeoutSeconds === 0 || data.result.length) Logger.log('Fetched ' + data.result.length + ' update(s), offset=' + (lastOffset + 1));
  if (!data.result.length) return;

  // Multi-photo listings arrive as an "album" — each photo as its own message,
  // all sharing the same media_group_id, usually only one of them carrying the
  // caption. Group them within this batch before processing.
  const mediaGroups = {}; // media_group_id -> { chatId, captionText, captionEntities, photoIds: [], isForwarded, sourceUsername }
  const singleMessages = [];

  data.result.forEach(update => {
    if (update.callback_query) {
      try { handleCallback(update.callback_query); }
      catch (err) { Logger.log('handleCallback error: ' + err); }
    } else if (update.channel_post) {
      // Posts made directly in a channel the bot administers (not sent to the
      // bot's private chat) — logged so a channel's Chat ID can be read off
      // once the bot is added as admin and any message is posted there.
      const cp = update.channel_post;
      Logger.log('channel_post: chat.id=' + cp.chat.id + ' title="' + cp.chat.title + '" username="' + (cp.chat.username || '') + '" text="' + (cp.text || cp.caption || '') + '"');
    } else if (update.message_reaction_count) {
      try { handleReactionUpdate(update.message_reaction_count); }
      catch (err) { Logger.log('handleReactionUpdate error: ' + err); }
    } else if (update.message) {
      const m = update.message;
      if (m.date) LAST_MESSAGE_LAG_S = Math.max(0, Math.round(Date.now() / 1000 - m.date));
      let handledAsUnitReply = false;
      try { handledAsUnitReply = handleUnitReply(m); }
      catch (err) { Logger.log('handleUnitReply error: ' + err); }
      if (handledAsUnitReply) {
        // a reply to one of the bot's own website messages (draft created, price card): handled
      } else if (m.reply_to_message && String(m.chat.id) === REVIEWER_CHAT_ID && looksLikeStatusKeyword(m.text)) {
        // Nick replying "SOLD" / "RENTED" / etc. directly to a listing's review
        // message — update the already-posted channel messages in place.
        try { handleStatusReply(m.chat.id, m.text, m.reply_to_message.message_id); }
        catch (err) { Logger.log('handleStatusReply error: ' + err); }
      } else if (m.poll) {
        try { handleIncomingPoll(m.chat.id, m.poll); }
        catch (err) { Logger.log('handleIncomingPoll error: ' + err); }
      } else if (m.media_group_id) {
        const gid = m.media_group_id;
        if (!mediaGroups[gid]) mediaGroups[gid] = { chatId: m.chat.id, captionText: '', captionEntities: null, photoIds: [], imageIds: [], isForwarded: false, sourceUsername: null };
        const photoId = getMediaId(m); // a photo's file_id, or 'v:' + a video's file_id
        if (photoId) mediaGroups[gid].photoIds.push(photoId);
        const imageId = getImageFileId(m); // photos AND image files: used only by the #unit intake
        if (imageId) mediaGroups[gid].imageIds.push(imageId);
        warnAboutHeic(m);
        if (m.caption) { mediaGroups[gid].captionText = m.caption; mediaGroups[gid].captionEntities = getMessageEntities(m); }
        if (isMessageForwarded(m)) mediaGroups[gid].isForwarded = true;
        const srcU = getForwardSourceUsername(m);
        if (srcU) mediaGroups[gid].sourceUsername = srcU;
      } else {
        singleMessages.push(m);
      }
    }
    props.setProperty('LAST_UPDATE_OFFSET', String(update.update_id));
  });

  singleMessages.forEach(m => {
    try {
      const photoId = getMediaId(m);
      const imageId = getImageFileId(m);
      warnAboutHeic(m);
      handleIncomingMessage(m.chat.id, m.caption || m.text || '', photoId ? [photoId] : [], isMessageForwarded(m), getForwardSourceUsername(m), getMessageEntities(m), imageId ? [imageId] : []);
    } catch (err) { Logger.log('handleIncomingMessage error: ' + err); }
  });

  Object.keys(mediaGroups).forEach(gid => {
    const g = mediaGroups[gid];
    // Telegram can deliver one album in two batches. If the caption (#unit) came in an earlier batch,
    // these captionless photos belong to that draft: add them quietly, never run the listing flow on them.
    if (!g.captionText && unitAddLateAlbumPhotos(g.chatId, gid, g.imageIds, g.photoIds)) return;
    try { handleIncomingMessage(g.chatId, g.captionText, g.photoIds, g.isForwarded, g.sourceUsername, g.captionEntities, g.imageIds, gid); }
    catch (err) { Logger.log('handleIncomingMessage(group) error: ' + err); }
  });
}

function isMessageForwarded(m) {
  return !!(m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_sender_name);
}

// Username of the channel a message was forwarded from, if any (covers both
// the older forward_from_chat shape and the newer forward_origin shape).
function getForwardSourceUsername(m) {
  if (m.forward_from_chat && m.forward_from_chat.username) return m.forward_from_chat.username;
  if (m.forward_origin) {
    if (m.forward_origin.chat && m.forward_origin.chat.username) return m.forward_origin.chat.username;
    if (m.forward_origin.sender_chat && m.forward_origin.sender_chat.username) return m.forward_origin.sender_chat.username;
  }
  return null;
}

// Nick's own channel where he posts already-final listings — forwards from
// here skip reformatting entirely and only get translated.
const OWN_CHANNEL_USERNAME = 'NickREAKH';

// ── Claude API fallback — for listing formats none of the 3 hardcoded
//    parsers recognize (arbitrary layouts from other agents' channels).
//    Requires a CLAUDE_API_KEY Script Property; if missing, this step is
//    skipped entirely and the bot falls back to the old "couldn't
//    recognize" message. See deploy notes for how to add the key.

const CLAUDE_MODEL = 'claude-haiku-4-5';

const CLAUDE_LISTING_SYSTEM_PROMPT =
  "You convert messy real estate listing text into Property Hub Cambodia's standard listing format. " +
  "Output ONLY the reformatted listing — no preamble, no explanation, no markdown code fences.\n\n" +
  "Format exactly:\n" +
  "#ForSale $<price>\n" +
  "(or #ForRent $<price>/month — use whichever applies. Include only the one that applies.)\n\n" +
  "<PROJECT NAME> | <UNIT TYPE>\n\n" +
  "――――――――――\n\n" +
  "UNIT DETAILS\n" +
  "✅ <fact from the source text>\n" +
  "✅ <fact from the source text>\n" +
  "(one bullet per fact — floor, size, bedrooms, price breakdown, etc.)\n\n" +
  "Strict rules:\n" +
  "- Extract exact numbers from the source. Never estimate, round, or invent a price, size, floor, or bedroom count.\n" +
  "- If the source has no clear price, omit the #ForSale/#ForRent line entirely rather than guessing.\n" +
  "- Never include phone numbers, WhatsApp, Telegram links, or any contact info from the source — omit them completely.\n" +
  "- Title format is 'NAME | TYPE', e.g. 'TIME SQUARE 5 | 1BR UNIT'.\n" +
  "- If the source text isn't a property listing at all, output exactly: NOT_A_LISTING";

// Returns reformatted listing text, or null if the API key is missing, the
// call fails, or the model determined the input wasn't a listing at all.
function reformatViaClaudeAPI(text) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return null;

  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: 800,
    system: CLAUDE_LISTING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  };

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log('reformatViaClaudeAPI failed: ' + resp.getContentText());
    return null;
  }

  const data = JSON.parse(resp.getContentText());
  if (data.stop_reason === 'refusal' || !data.content || !data.content.length) return null;

  const reformatted = data.content[0].text.trim();
  if (reformatted === 'NOT_A_LISTING') return null;
  return reformatted;
}

// Telegram Premium custom emoji are a plain fallback char + an invisible
// "entity" (offset/length/custom_emoji_id) layered on top — not part of the
// text itself. Only valid to reuse when the text is sent byte-identical to
// the original (any reconstruction shifts character positions and breaks it).
function getMessageEntities(m) {
  return m.caption_entities || m.entities || null;
}

// ── Incoming message handling (listing detection) ──────────────────

function handleIncomingMessage(chatId, text, photoFileIds, isForwarded, sourceUsername, originalEntities, imageFileIds, mediaGroupId) {
  if (String(chatId) !== REVIEWER_CHAT_ID) return; // only from you, in your private chat with the bot

  // The menu "What should I do with this post?" (see UNIT INTAKE at the bottom). It handles typed answers,
  // #unit posts, and anything with photos or that looks like a listing. Plain chat falls through, silent as before.
  if (routeIncoming(chatId, text, photoFileIds, isForwarded, sourceUsername, originalEntities, imageFileIds, mediaGroupId)) return;
  processChannelListing(chatId, text, photoFileIds, isForwarded, sourceUsername, originalEntities);
}

// The original listing flow (forward or paste a listing, EN/JP/RU/DE versions, your approval, then post).
// pageUrl and refCode are only given by the "Both" route, to add the live page link and reference to each post.
// Temporary timing report: set the script property DEBUG_TIMING to 1 and the bot tells you where the time went.
function debugTiming() { return PropertiesService.getScriptProperties().getProperty('DEBUG_TIMING') === '1'; }
let LAST_MESSAGE_LAG_S = null; // seconds between you sending a message and the bot first seeing it

function processChannelListing(chatId, text, photoFileIds, isForwarded, sourceUsername, originalEntities, pageUrl, refCode) {
  if (String(chatId) !== REVIEWER_CHAT_ID) return; // only from you, in your private chat with the bot
  const T0 = Date.now(), marks = [];
  const mark = function (label) { marks.push(label + ' ' + ((Date.now() - T0) / 1000).toFixed(1) + 's'); };

  // Anything forwarded straight from your own channel is trusted outright —
  // no hashtag/shape check at all. It's not always a single-property listing
  // (e.g. multi-project promo posts, announcements) so it can't be forced
  // through the UNIT DETAILS/FEATURES bullet parser, which assumes one fixed
  // schema. Whole-block translate preserves whatever structure it actually has.
  const isFromOwnChannel = sourceUsername && sourceUsername.toLowerCase() === OWN_CHANNEL_USERNAME.toLowerCase();

  let fields, assembleFn;
  let ownAsUnit = false; // a forward from your channel that is a single unit is rebuilt in the compact layout like any other listing
  if (isFromOwnChannel) {
    const tried = parseListingText(text);
    ownAsUnit = COMPACT_LISTING_LAYOUT && !!((tried.forSale || tried.forRent) && tried.bullets.some(function (b) { return b.icon === '✅' && parseBedBathText(b.text); }));
    fields = ownAsUnit ? tried : null;
    assembleFn = ownAsUnit ? assembleListing : null; // otherwise handled directly below via translateWholeText
  } else {
    // Three source formats supported for everything else: our own
    // #ForSale/#ForRent/#NewProject template (e.g. output from the ChatGPT
    // formatting step); a foreign-language listing (e.g. Chinese, from
    // someone else's channel) — detected by CJK characters plus a dollar
    // amount, since it won't have our hashtag; or another agent's own
    // English-language format using a "[FOR RENT]"/"[FOR SALE]" bracket tag
    // instead of our hashtag (e.g. content shared in from other channels).
    let hasOwnHashtag = /#ForSale|#ForRent|#NewProject/i.test(text);
    let hasForeignListing = /[一-鿿]/.test(text) && /\$[\d,]+/.test(text);
    let hasBracketTag = /\[\s*for\s+(sale|rent)\s*\]/i.test(text);
    let hasFreeformListing = !hasOwnHashtag && !hasForeignListing && !hasBracketTag && hasListingVocabulary(text);

    if (!hasOwnHashtag && !hasForeignListing && !hasBracketTag && !hasFreeformListing) {
      // None of the 4 known shapes matched — try the Claude API fallback
      // before giving up. It only activates if CLAUDE_API_KEY is set; if the
      // key's missing or the call fails, this is a silent no-op and control
      // falls through to the "couldn't recognize" message below unchanged.
      const reformatted = reformatViaClaudeAPI(text);
      if (reformatted) {
        text = reformatted;
        hasOwnHashtag = /#ForSale|#ForRent|#NewProject/i.test(text);
      }
    }

    if (!hasOwnHashtag && !hasForeignListing && !hasBracketTag && !hasFreeformListing) {
      // Only speak up if this looked like an attempted listing (has a photo, or
      // was forwarded) — stay silent for plain chat like "hi" so the bot isn't noisy.
      const looksLikeAttemptedListing = (photoFileIds && photoFileIds.length > 0) || isForwarded;
      if (looksLikeAttemptedListing) {
        sendTelegramMessage(REVIEWER_CHAT_ID,
          "🤔 I couldn't recognize this as a listing — no #ForSale, #ForRent, or #NewProject tag found.\n\n" +
          "If this was meant to be a listing, run it through ChatGPT first using PHC's listing format rules, then forward the result here.");
      }
      return;
    }

    // Contact info is only ever trusted from a genuine t.me/NickREAKH forward
    // (handled above) — text that merely LOOKS like your template but was
    // pasted, not forwarded, still gets fully rebuilt so its contact info
    // can't slip through unreplaced.
    if (hasOwnHashtag) {
      fields = parseListingText(text);
      assembleFn = assembleListing;
    } else if (hasBracketTag) {
      fields = parseBracketListing(text);
      assembleFn = assembleListing;
    } else if (hasForeignListing) {
      fields = parseChineseListingText(text);
      assembleFn = assembleListing;
    } else {
      fields = parseFreeformListing(text);
      assembleFn = assembleListing;
      // The post names no area: take it from the website if it names one of our projects ("Time Square 8" is in TTP, Phnom Penh).
      if (!fields.location) {
        let project = null;
        try { project = findProjectInText(text, fetchUnitProjects()); } catch (e) { Logger.log('project lookup failed: ' + e); }
        if (project && project.location) fields.location = project.location + (project.city ? ', ' + project.city : '');
      }
    }
  }

  mark('read the post');
  const sourceId = 'L' + Date.now();
  const sheet = getQueueSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  mark('opened the sheet');
  const photoJson = photoFileIds && photoFileIds.length ? JSON.stringify(photoFileIds) : '';

  sendTelegramMessage(REVIEWER_CHAT_ID, '📥 Listing detected (' + mediaCountText(photoFileIds) + ') — generating EN/JP/RU/DE versions for your review...');

  mark('sent "Listing detected"');
  // Own-channel forwards carry their own contact info (Nick's personal
  // phone/Telegram) — strip it so CONTACT_STANDARD (PHC's own number/channel)
  // is what every post shows, same as every other source path. Text is
  // therefore always rebuilt now, never sent byte-for-byte untouched.
  const ownChannelBody = isFromOwnChannel && !ownAsUnit ? stripTrailingContactBlock(text) + '\n\n――――――――――\n' + CONTACT_STANDARD : '';

  // The review message needs only the English text, so it goes out as soon as the EN row is ready. JP, RU and DE are translated
  // after that, while you are reading it. Approve All is handled only after this run finishes, so the rows are always complete.
  let reviewMsg = null;
  ['EN', 'JP', 'RU', 'DE'].forEach(lang => {
    let content;
    if (isFromOwnChannel && !ownAsUnit) {
      // JP/RU/DE: whole-block translate — this content isn't guaranteed to
      // match the single-listing bullet schema, so there's nothing to
      // structurally parse; translate the full text as one unit. CONTACT_STANDARD
      // itself is never translated (same as assembleListing does elsewhere).
      const strippedText = stripTrailingContactBlock(text);
      content = lang === 'EN' ? ownChannelBody : translateWholeText(strippedText, lang) + '\n\n――――――――――\n' + CONTACT_STANDARD;
    } else {
      content = assembleFn(fields, lang);
    }
    // Entities are only valid against the exact original text — now that
    // contact info is always stripped/replaced, text is never sent untouched,
    // so entities never reliably line up anymore. (Premium custom-emoji
    // entities were already silently stripped by Telegram for a non-Premium
    // bot account regardless — see known limitation in memory — so this
    // preserves nothing that was actually working.)
    if (pageUrl) content = addPageLink(content, pageUrl, refCode);
    const rowEntities = '';

    const rowNum = sheet.getLastRow() + 1;
    const row = headers.map(h => {
      if (h === 'id') return sourceId + '-' + lang;
      if (h === 'createdAt') return new Date().toISOString();
      if (h === 'language') return lang;
      if (h === 'content') return content;
      if (h === 'photoFileId') return photoJson;
      if (h === 'entities') return rowEntities;
      return '';
    });
    sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
    if (lang === 'EN') {
      // One review message covering all 4 languages: approving posts to all channels at once (same listing, translated).
      mark('EN row written');
      reviewMsg = sendCombinedReviewMessage(sheet, headers, sourceId, photoFileIds);
      mark('REVIEW SENT');
    } else if (reviewMsg) {
      sheet.getRange(rowNum, headers.indexOf('status') + 1).setValue('Pending Review');
      sheet.getRange(rowNum, headers.indexOf('reviewMsgId') + 1).setValue(reviewMsg.message_id || '');
    }
  });
  mark('all languages done');
  if (debugTiming()) sendTelegramMessage(REVIEWER_CHAT_ID, 'Timing (seconds from the start of preparing)\n' + marks.join('\n') + '\nRows in the queue sheet: ' + sheet.getLastRow() + (LAST_MESSAGE_LAG_S !== null ? '\nYour last message waited ' + LAST_MESSAGE_LAG_S + 's before the bot saw it' : ''));
}

// Reads the photoFileId cell, which may be a JSON array (multi-photo) or,
// for rows created before multi-photo support, a single plain file_id string.
function parsePhotoIds(cellValue) {
  if (!cellValue) return [];
  try {
    const parsed = JSON.parse(cellValue);
    return Array.isArray(parsed) ? parsed : [cellValue];
  } catch (e) {
    return [cellValue];
  }
}

// ── Listing parsing (source → raw fields, unclassified bullets) ────────
//
//   Matches PHC's actual ChatGPT listing prompt: ONE unified structure for
//   every listing type (For Sale / For Rent / Promotion / Resale / etc. —
//   ChatGPT picks the right content, but the output shape is always the
//   same). Bullets carry their own icon: ✅ for details/features, or one of
//   💧⚡🚗💼 for the optional utilities section — so bucketing is based on
//   the icon actually used, not guessed from keywords.

function parseListingText(text) {
  const plainText = fromBoldSansSerif(text);
  const lines = text.split('\n').map(l => l.trim());
  const plainLines = plainText.split('\n').map(l => l.trim());

  let forSale = '', forRent = '', title = '', location = '';
  const bullets = []; // { icon, text }
  let seenBullet = false;
  const bulletIcons = ['✅', '💧', '⚡', '🚗', '💼', '💳'];
  let urgent = false;
  let section = ''; // the last heading seen (UNIT DETAILS, FEATURES, FACILITIES ...)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const plain = plainLines[i];
    if (!line) continue;

    // Price line(s) — either on separate lines, or combined as
    // "#ForSale $X | #ForRent $Y/month" on one line.
    if (/#ForSale|#ForRent/i.test(plain) && /\burgent\b/i.test(plain)) urgent = true; // "#ForSale $99,000 (Urgent)"
    if (/#ForSale/i.test(plain)) {
      const m = line.match(/#ForSale\s*(\$[\d,]+)/i);
      if (m) forSale = m[1];
    }
    if (/#ForRent/i.test(plain)) {
      const m = line.match(/#ForRent\s*(\$[\d,]+(?:\/\S+)?)/i);
      if (m) forRent = m[1];
    }
    if (/#ForSale|#ForRent/i.test(plain)) continue;

    if (line.startsWith('📍')) { location = line.replace('📍', '').trim(); continue; }
    if (/^[―\-_=]{3,}$/.test(line)) continue; // divider
    if (/^[A-Z\s]{3,}$/.test(plain) && !bulletIcons.some(ic => line.startsWith(ic))) { section = plain.trim(); continue; } // section labels (UNIT DETAILS, FEATURES, etc.)
    if (line.startsWith('📞')) break; // contact block — stop parsing, we use our own contact info

    if (/^[\u{1F6CF}\u{1F6C1}]/u.test(line)) { // "🛏 1 Bed | 🛁 1 Bath": read like a ✅ detail, the bed and bath line is rebuilt later
      seenBullet = true;
      bullets.push({ icon: '✅', text: line.replace(/^[\u{1F6CF}\u{1F6C1}\uFE0F\s]+/u, '').trim(), section });
      continue;
    }
    const icon = bulletIcons.find(ic => line.startsWith(ic));
    if (icon) {
      seenBullet = true;
      bullets.push({ icon, text: line.slice(icon.length).trim(), section });
      continue;
    }
    if (line.includes('|') && !title && !seenBullet) { title = line; continue; }
  }

  return { forSale, forRent, title, location, bullets, sourceLang: 'en', urgent };
}

// ── Foreign-language listing parsing (e.g. Chinese source channels) ────
//
//   Different structure from our own template: 🏢 title line, 💰/📍/📐
//   labeled fields, ✅/⚡/💧/🚙-prefixed bullets, no #ForSale hashtag,
//   contact block always replaced with our own (never carry over a
//   competitor's contact info).

function stripLeadingSymbols(line) {
  return line.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function parseChineseListingText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let rawTitle = '', priceValue = '', isRent = false, location = '', area = '';
  const bullets = []; // { icon, text }
  let pastFeatures = false;
  const utilityIcons = ['💧', '⚡', '🚗', '🚙', '💼'];

  lines.forEach((line, idx) => {
    if (idx === 0) { rawTitle = line; return; }
    if (/出租/.test(line)) isRent = true;
    if (/💰|转售价格|售价|租金|价格/.test(line)) {
      const m = line.match(/\$[\d,]+(?:\/[^\s]+)?/);
      if (m) priceValue = m[0];
      return;
    }
    if (line.startsWith('📍')) { location = stripLeadingSymbols(line.replace(/位置[:：]?/, '')); return; }
    if (line.startsWith('📐')) { area = stripLeadingSymbols(line.replace(/面积[:：]?/, '')); return; }
    if (line.startsWith('📎') || /^在线咨询|^微信号|^电话|t\.me\//.test(line)) { pastFeatures = true; return; }
    if (pastFeatures) return;

    const utilityIcon = utilityIcons.find(ic => line.startsWith(ic));
    const content = stripLeadingSymbols(line);
    if (content) bullets.push({ icon: utilityIcon === '🚙' ? '🚗' : (utilityIcon || '✅'), text: content });
  });

  const titleClean = stripLeadingSymbols(rawTitle);
  const titleParts = titleClean.split(/[｜|]/).map(s => s.trim()).filter(Boolean);
  if (area) bullets.unshift({ icon: '✅', text: area });

  return {
    forSale: !isRent ? priceValue : '',
    forRent: isRent ? priceValue : '',
    title: titleParts.join(' | '),
    location,
    bullets,
    sourceLang: 'zh',
  };
}

// ── Bracket-tag listing parsing (other agents' own English format) ─────
//
//   e.g. "[FOR RENT] 1BR at TS 306" then "●"-prefixed bullets, one of which
//   is a "Price: 700$ | Month" line — promoted into the forSale/forRent
//   field like our own template's price line. Contact info (phone, t.me
//   link) at the end is discarded — never carry over another agent's own
//   contact details, matches the same rule used for Chinese-source listings.

function parseBracketListing(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let forSale = '', forRent = '', title = '', isRent = false;
  const bullets = [];
  // Bullet markers seen in the wild across different agents' own formats —
  // not just the plain dots (●•◦‣) PHC originally expected, but the emoji
  // checkmarks/money-bag markers other agents commonly use too.
  const bulletChars = ['●', '•', '◦', '‣', '✅', '✓', '☑️', '☑', '💰', '🏷️', '🏷', '👉', '▪️', '▪', '■', '★'];

  // The [FOR SALE]/[FOR RENT] tag isn't always the first line — some posts
  // lead with a headline before it (e.g. "Stunning 1-Bedroom Condo ✨" then
  // "[For Rent] 1Bedroom at Vue Aston" on the next line). Find the tag
  // wherever it actually is instead of assuming line 0.
  let tagLineIdx = -1, tagMatch = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\[\s*for\s+(sale|rent)\s*\]/i);
    if (m) { tagLineIdx = i; tagMatch = m; break; }
  }

  if (tagLineIdx > -1) {
    isRent = /rent/i.test(tagMatch[1]);
    const headline = lines.slice(0, tagLineIdx).join(' — ').trim();
    const afterTag = lines[tagLineIdx].replace(tagMatch[0], '').trim();
    title = [headline, afterTag].filter(Boolean).join(' — ');
  } else {
    // No tag found at all — fall back to the old assumption (line 0 is the
    // title) rather than losing everything.
    title = lines[0] || '';
  }

  lines.forEach((line, idx) => {
    if (idx <= tagLineIdx) return; // already consumed as headline/tag above

    const bulletChar = bulletChars.find(c => line.startsWith(c));
    if (!bulletChar) return; // contact block / anything else — discard

    const content = line.slice(bulletChar.length).trim();
    // Price lines: either explicitly labelled ("Price: ...") or marked with
    // a money-bag bullet, or phrased as "Only $X ...".
    if (/^price\s*:?/i.test(content) || bulletChar.indexOf('💰') === 0 || /^only\s/i.test(content)) {
      const amt = content.match(/[\d,]+/);
      if (amt) {
        const period = /month|\bmo\b/i.test(content) ? '/month' : '';
        const priceStr = '$' + amt[0] + period;
        if (isRent) forRent = priceStr; else forSale = priceStr;
      }
      return;
    }
    bullets.push({ icon: '✅', text: content });
  });

  return { forSale, forRent, title, location: '', bullets, sourceLang: 'en' };
}

// ── Freeform listing parsing (no tag at all — recognized by vocabulary) ──
//
//   Some agents post plain "Label Value" lines with no #hashtag, no [FOR
//   RENT] bracket, no bullet markers at all — just recognizable real-estate
//   words (bedroom, floor, size, price...) plus a dollar amount. Detected by
//   keyword density rather than any tag, so it stays free (no API call).

function hasListingVocabulary(text) {
  const wordKeywords = text.match(/\b(bedrooms?|bathrooms?|studios?|floors?|size|furnitur\w*|furnish\w*|balcon\w*|units?)\b/gi) || [];
  // "sqm" has no word boundary before it in e.g. "60sqm" (digit + letter are
  // both \w chars) — matched separately, without requiring a leading \b.
  const areaKeywords = text.match(/sq\.?\s?m(?:eter|etre)?s?\b/gi) || [];
  // Price can appear as "$130,000" or "130,000$" — both conventions have shown up.
  const hasDollarAmount = /\$\s?[\d,]{3,}|[\d,]{3,}\s?\$/.test(text);
  return (wordKeywords.length + areaKeywords.length) >= 2 && hasDollarAmount;
}

// Strips Khmer-script words (Unicode block U+1780–U+17FF, also covers the
// ៛ Riel symbol) from a line that duplicates the same fact in English —
// common in Cambodian listings ("Floor : 7th | ជាន់ទី 07"). Leaves any
// digits/Latin text in the Khmer segment alone (can't tell duplicate numbers
// apart from the English ones), so cleanup is best-effort, not perfect —
// but it's a large readability improvement over leaving raw Khmer script in
// a bullet that then gets machine-translated to JP/RU/DE.
function stripKhmerDuplicateText(line) {
  return line
    .replace(/[ក-៿]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s|/]+$/, '')
    .trim();
}

// "Urgent Sale – Time Square 8 | 2-Bedroom Resale Unit" -> "Time Square 8 | 2BR Resale" (the house style, as in "GATO TOWER | 2BR UNIT").
function cleanFreeformTitle(line) {
  return String(line || '')
    .replace(/\(\s*urgent\s*\)/gi, '')
    .replace(/^\s*urgent\s*(?:sale|rent|rental|deal|resale)?\s*[–—:|\-]+\s*/i, '')
    .replace(/\b([0-9]{1,2})\s*-?\s*(?:bed\s?rooms?|beds?|br)\b/gi, '$1BR')
    .replace(/\b(resale|rental|rent|sale)\s+unit\s*$/i, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseFreeformListing(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const contactLineRegex = /📞|📱|🌐|whatsapp|telegram|t\.me\/|facebook\.com|https?:\/\/|contact for viewing|\btel\s*[:.]|\bphone\s*[:.]|\bhotline\b|\bcall\s*[:.]/i;
  // A post that says it is for sale is a sale, whatever else it mentions. "Monthly Payment" in a payment plan is not a rent
  // signal either; only the word rent or a price per month is.
  const saysSale = /\b(for sale|forsale|sale|selling|resale|sell)\b/i.test(text);
  const isRentOverall = !saysSale && /\brent\b|\/\s?month|\bper month\b/i.test(text);
  // Headings that introduce a block ("Property Details", "Payment Plan") are not facts: no tick, and never the title.
  const sectionHeadingRegex = /^(property|unit|project|listing)\s+(details|information|info|overview|highlights)$|^(payment\s+(plan|schedule|terms|structure)|features|facilities|amenities|highlights|description|details|specifications|overview|key features|contact|notes?)$/i;

  let forSale = '', forRent = '', title = '', location = '';
  const bullets = [];
  let titleFound = false;
  const urgent = /\burgent\b/i.test(text); // shown as "(Urgent)" after the price, never as words in the title
  const paymentLineRegex = /^(monthly(?:\s+payment)?|handover(?:\s+payment)?|down\s*payment|booking(?:\s+fee)?|deposit|instal+ments?|final\s+payment|balance(?:\s+payment)?)\b/i;

  lines.forEach(rawLine => {
    // Strip Khmer duplicate text first, then any leading bullet/emoji marker
    // (⁃, -, ➡️, ✅, etc.) — our own template adds its own ✅ icon on assembly,
    // so a leftover source marker would just double up visually.
    const line = stripLeadingSymbols(stripKhmerDuplicateText(rawLine)).replace(/🔥/g, '').replace(/\s{2,}/g, ' ').trim();
    if (!line) return;
    if (contactLineRegex.test(rawLine) || contactLineRegex.test(line)) return; // never carry over another agent's contact info (checked before the leading 📞 is stripped)
    if (sectionHeadingRegex.test(line.replace(/[:：\s]+$/, ''))) return;
    if (/^\s*📍/.test(rawLine) && !location) { location = line; return; } // the post's own area line
    // "Project: Time Square 8" says nothing the title does not: drop it when the title already names the project
    const projectLine = line.match(/^(?:project|building|development)\s*(?:name)?\s*[:：-]\s*(.+)$/i);
    if (projectLine && titleFound && title.toLowerCase().indexOf(projectLine[1].trim().toLowerCase()) !== -1) return;

    if (/\b(price|rental|rent)\b/i.test(line) && /[\d,]+/.test(line)) {
      const amt = line.match(/[\d,]+/);
      if (amt) {
        const priceStr = '$' + amt[0] + (isRentOverall ? '/month' : '');
        if (isRentOverall) forRent = priceStr; else forSale = priceStr;
      }
      return;
    }

    if (/^urgent(\s+(sale|rent|rental|deal|resale))?[\s!.]*$/i.test(line)) return; // a line that only says Urgent: it becomes the (Urgent) mark
    if (!titleFound) {
      const cleaned = cleanFreeformTitle(line);
      if (cleaned) { title = cleaned; titleFound = true; }
      return;
    }
    bullets.push({ icon: paymentLineRegex.test(line) ? '💳' : '✅', text: line });
  });

  return { forSale, forRent, title, location, bullets, sourceLang: 'en', urgent };
}

// ── Bullet bucketing — one unified structure for every listing type ────
//
//   ✅ bullets split into Unit Details vs Features by content (structural
//   facts vs marketing points). Utility-icon bullets (💧⚡🚗💼) always go
//   into their own Utilities section, keeping their original icon instead
//   of ✅ — only included at all if the source actually had any.

function classifyBullet(text) {
  const featureHints = /investment|opportunit|afforda|prime|rental demand|ideal for|luxury|convenien|walk|near|close to|high floor|city view|swimming|pool|gym|fitness|amenit|move-?in|modern|resale|urgent|reduced/i;
  return featureHints.test(text) ? 'features' : 'details';
}

// ── Bedrooms and bathrooms: one line, always first in UNIT DETAILS ─────────────
// "🛏 1 Bed | 🛁 1 Bath". The words come from this table in every language (not from the translator), so Bed and Bath can
// never be mistranslated and the line needs no translator call.
const BEDBATH_ICONS = /[\u{1F6CF}\u{1F6C1}\uFE0F]/gu;

// "1 Bedroom | 1 Bathroom", "🛏 1 Bed | 🛁 1 Bath", "Studio | 1 Bath", "2 Beds". Anything with other words ("1 Bedroom Duplex") is not a match.
function parseBedBathText(text) {
  const t = String(text || '').replace(BEDBATH_ICONS, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const segs = t.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!segs.length || segs.length > 2) return null;
  let beds = null, baths = null, m;
  for (let i = 0; i < segs.length; i++) {
    // "Unit Type: 2 Bedrooms", "Bedroom: 2", "Bathrooms: 1": a label in front of the number is fine
    segs[i] = segs[i].replace(/^(?:unit\s*type|type)\s*[:：]\s*/i, '');
    if ((m = segs[i].match(/^(?:bed(?:room)?s?|br)\s*[:：]\s*([0-9]+)$/i))) { beds = parseInt(m[1], 10); continue; }
    if ((m = segs[i].match(/^bath(?:room)?s?\s*[:：]\s*([0-9]+(?:[.,][0-9]+)?)$/i))) { baths = parseFloat(m[1].replace(',', '.')); continue; }
    if (/^studio$/i.test(segs[i])) beds = 0;
    else if ((m = segs[i].match(/^([0-9]+)\s*[- ]?(?:bed(?:room)?s?|br)$/i))) beds = parseInt(m[1], 10);
    else if ((m = segs[i].match(/^([0-9]+(?:[.,][0-9]+)?)\s*[- ]?bath(?:room)?s?$/i))) baths = parseFloat(m[1].replace(',', '.'));
    else return null;
  }
  if (beds === null && baths === null) return null;
  return { beds: beds, baths: baths };
}

function ruPlural(n, one, few, many, fraction) {
  if (n !== Math.floor(n)) return fraction || many; // 1.5 ванной
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

function formatBedBath(bb, lang) {
  const parts = [];
  const num = function (x) { return String(x); };
  if (bb.beds !== null && bb.beds !== undefined) {
    const n = bb.beds;
    let word;
    if (n === 0) word = { EN: 'Studio', JP: 'スタジオ', RU: 'Студия', DE: 'Studio' }[lang];
    else if (lang === 'JP') word = num(n) + 'ベッドルーム';
    else if (lang === 'RU') word = num(n) + ' ' + ruPlural(n, 'спальня', 'спальни', 'спален', 'спальни');
    else if (lang === 'DE') word = num(n) + ' Schlafzimmer';
    else word = num(n) + ' ' + (n === 1 ? 'Bed' : 'Beds');
    parts.push('🛏 ' + word);
  }
  if (bb.baths !== null && bb.baths !== undefined) {
    const n = bb.baths;
    let word;
    if (lang === 'JP') word = num(n) + 'バスルーム';
    else if (lang === 'RU') word = num(n) + ' ' + ruPlural(n, 'ванная', 'ванные', 'ванных', 'ванной');
    else if (lang === 'DE') word = num(n) + ' ' + (n === 1 ? 'Bad' : 'Bäder');
    else word = num(n) + ' ' + (n === 1 ? 'Bath' : 'Baths');
    parts.push('🛁 ' + word);
  }
  return parts.join(' | ');
}

function bucketListing(bullets) {
  const details = [], features = [], payments = [], utilities = [];
  bullets.forEach(b => {
    if (b.icon === '✅') {
      (classifyBullet(b.text) === 'features' ? features : details).push(b);
    } else if (b.icon === '💳') {
      payments.push(b);
    } else {
      utilities.push(b);
    }
  });
  const sections = [['UNIT DETAILS', details], ['FEATURES', features]];
  if (payments.length) sections.push(['PAYMENT PLAN', payments]);
  if (utilities.length) sections.push(['UTILITIES', utilities]);
  return sections;
}

// ── Final assembly — translate + apply the unified template shape ──────

// Words the translator must never change: Google reads "BKK1" as Bangkok airport, and turns project names into katakana or Cyrillic.
// BKK1, BKK2, BKK3 (Boeung Keng Kang) and PHC's own project names are kept exactly as written, in every language.
const PROTECTED_NAMES = [
  'Time Square', 'Odom Living', 'Odom Tower', 'GATO Tower', 'Picasso Sky Gemme', 'Le Conde', 'Kingston Royale', 'Norea Square',
  'Diamond Bay Garden', 'J Tower', 'LZ Sea View Premium', 'UC88 Wyndham Garden', 'Rose Apple Square', 'Angkor Grace', 'Residence L',
  'Property Hub Cambodia', 'PHC',
];
const BANGKOK_FORMS = /(バンコク|Бангкок|Bangkok|曼谷)\s?([1-3])?/g;

function protectedTermRegex() {
  let names = PROTECTED_NAMES.slice();
  try { // project names already on the website (cached for an hour by the unit intake), when they are at hand
    const raw = CacheService.getScriptCache().get('unitprojects');
    if (raw) JSON.parse(raw).forEach(function (p) { if (p && p.title && names.indexOf(p.title) === -1) names.push(p.title); });
  } catch (e) { /* the built in list is enough */ }
  const esc = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  names.sort(function (a, b) { return b.length - a.length; }); // longest first, so "Time Square" is not cut short
  return new RegExp('\\bBKK[1-3]?\\b|\\b(?:' + names.map(esc).join('|') + ')(?:\\s?\\d{1,2})?(?![A-Za-z0-9])', 'gi'); // any capitals: an ALL CAPS line is lowercased before it is translated
}

function escapeHtmlText(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function unescapeHtmlText(t) { return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }

// Sends the text with the protected words marked "do not translate", then removes the marks again.
// Safety net: if the translator still turned BKK into Bangkok, the original BKK is put back.
function translateKeepingNames(text, sourceLang, targetCode) {
  const re = protectedTermRegex();
  if (!re.test(text)) return LanguageApp.translate(text, sourceLang, targetCode);
  re.lastIndex = 0;
  const marked = escapeHtmlText(text).replace(new RegExp(re.source.replace(/&/g, '&amp;'), 'gi'), function (m) { return '<span translate="no">' + m + '</span>'; });
  let out;
  try { out = unescapeHtmlText(LanguageApp.translate(marked, sourceLang, targetCode, { contentType: 'html' }).replace(/<\/?span[^>]*>/gi, '')); }
  catch (e) { out = LanguageApp.translate(text, sourceLang, targetCode); } // html mode refused: plain text, the safety net below still applies
  const bkk = text.match(/\bBKK[1-3]?\b/i);
  if (bkk && !/bangkok/i.test(text)) out = out.replace(BANGKOK_FORMS, function (m, w, d) { return 'BKK' + (d || ''); });
  return out;
}

function translateField(text, sourceLang, lang) {
  if (!text) return text;
  const targetCode = { EN: 'en', JP: 'ja', RU: 'ru', DE: 'de' }[lang];
  if (sourceLang === 'en' && lang === 'EN') return text; // already English, no-op
  try {
    // Google's translator often leaves short ALL-CAPS phrases untouched
    // (reads them as acronyms/labels, not text) — e.g. "PROJECTS FEATURED"
    // and "PAYMENT PLAN" came back unchanged while normal sentences
    // translated fine. Lowercase before translating, then re-uppercase the
    // result — sentence-case text translates reliably; still displays in caps.
    const isAllCaps = text === text.toUpperCase() && text !== text.toLowerCase();
    const toTranslate = isAllCaps ? text.toLowerCase() : text;
    // Lines such as "Fully Furnished" or "Swimming Pool & Gym" come back in almost every listing, so a translation is
    // remembered for 6 hours (the longest the script cache allows) and the translator is only asked once.
    const cacheKey = 'tr_' + sourceLang + '_' + targetCode + '_' + toTranslate;
    const cache = toTranslate.length <= 120 ? CacheService.getScriptCache() : null;
    let translated = cache ? cache.get(cacheKey) : null;
    if (translated === null || translated === undefined) {
      translated = translateKeepingNames(toTranslate, sourceLang, targetCode);
      if (cache && translated) { try { cache.put(cacheKey, translated, 21600); } catch (e) { /* a full cache only costs speed */ } }
    }
    return isAllCaps ? translated.toUpperCase() : translated;
  } catch (err) {
    Logger.log('translate error: ' + err);
    return text; // fall back to source text if translation fails — better than a broken post
  }
}

// Translates content forwarded from your own channel that doesn't match the
// single-listing bullet/section schema (promo posts, announcements, etc.).
// Translates LINE BY LINE rather than as one big block — sending the whole
// multi-paragraph text in a single call lets the translator take liberties
// with structure. Per-line keeps each header/bullet anchored to its own line.
function translateWholeText(text, lang) {
  if (lang === 'EN' || !text) return text;
  return text.split('\n').map(line => {
    if (!line.trim()) return line;
    // Headers use literal bold Unicode characters (the same 𝗧𝗜𝗠𝗘 𝗦𝗤𝗨𝗔𝗥𝗘-style
    // trick as your regular listings) — those glyphs aren't real Latin letters,
    // so Google's translator either drops them or returns garbage for that
    // line (confirmed via Execution log: "PROJECTS FEATURED" → "印刷物",
    // "printed matter" — nonsense). Convert to plain ASCII before translating,
    // then reapply bold styling to the result if the original line had it.
    const plainLine = fromBoldSansSerif(line);
    const bb = parseBedBathText(plainLine.replace(/^✅\s*/, ''));
    if (bb && /^(?:✅|\u{1F6CF})/u.test(plainLine.trim())) return formatBedBath(bb, lang); // not sent to the translator
    const wasBold = plainLine !== line;
    const translated = translateField(plainLine, 'en', lang);
    return wasBold ? toBoldSansSerif(translated) : translated;
  }).join('\n');
}

// " (Urgent)" after the price, worded by this table in every language (not by the translator).
const URGENT_WORD = { EN: 'Urgent', JP: '緊急', RU: 'Срочно', DE: 'Dringend' };
function urgentSuffix(fields, lang) { return fields && fields.urgent ? ' (' + (URGENT_WORD[lang] || URGENT_WORD.EN) + ')' : ''; }

function assembleListing(fields, lang) {
  // Bucketing classifies on ENGLISH text always — normalize to EN first
  // regardless of source or target language, then translate each already-
  // classified bullet for display. Otherwise JP/DE output (and any
  // zh-sourced listing, even in EN) silently loses its section structure,
  // since the classifier never matches non-English text.
  const toEn = (s) => s ? translateField(s, fields.sourceLang, 'EN') : s;
  const toLang = (enText) => (lang === 'EN' || !enText) ? enText : translateField(enText, 'en', lang);

  const titleEn = fields.sourceLang === 'zh' ? toEn(fields.title) : fields.title; // project names in our own template stay as-is
  const locationEn = fields.location ? toEn(fields.location) : '';
  const bulletsEn = fields.bullets.map(b => ({ icon: b.icon, text: toEn(b.text), section: b.section || '' }));

  // The bedroom and bathroom line is taken out here and put back first in UNIT DETAILS, built from the table (see formatBedBath).
  let bedbath = null;
  const restBullets = [];
  bulletsEn.forEach(b => {
    const bb = b.icon === '✅' ? parseBedBathText(b.text) : null;
    // a separate "Bedrooms: 2" line and "Bathrooms: 1" line join into one; a second line for the same thing stays a normal bullet
    const mergeable = bb && bedbath && ((bedbath.beds === null && bb.beds !== null && bb.baths === null) || (bedbath.baths === null && bb.baths !== null && bb.beds === null));
    if (bb && !bedbath) bedbath = bb;
    else if (mergeable) bedbath = { beds: bedbath.beds !== null ? bedbath.beds : bb.beds, baths: bedbath.baths !== null ? bedbath.baths : bb.baths };
    else restBullets.push(b);
  });
  // A single unit for sale or rent with its bedrooms and bathrooms known uses the compact layout (see assembleCompactListing).
  if (COMPACT_LISTING_LAYOUT && (fields.forSale || fields.forRent) && bedbath) return assembleCompactListing(fields, lang, restBullets, bedbath, titleEn, locationEn, toLang);
  const sections = bucketListing(restBullets); // classify on EN text — consistent structure across all languages

  // Project/place names are proper nouns — never machine-translate them, or
  // "TIME SQUARE 10" risks coming back garbled in JP/DE. Normalizing a zh
  // source's title/location to English (done above) is enough; after that,
  // keep as-is for every target language.
  const title = titleEn;
  const location = locationEn;
  const displaySections = sections.map(([header, items]) => [header, items.map(b => ({ icon: b.icon, text: toLang(b.text) }))]);
  if (bedbath) displaySections[0][1].unshift({ icon: '', text: formatBedBath(bedbath, lang), plain: true });

  let priceLine = '';
  if (fields.forSale) priceLine += '#ForSale ' + fields.forSale + urgentSuffix(fields, lang) + '\n';
  if (fields.forRent) priceLine += '#ForRent ' + fields.forRent + (fields.forSale ? '' : urgentSuffix(fields, lang)) + '\n';

  let body = priceLine.trim() + '\n\n' + toBoldSansSerif(title) + '\n';
  if (location) body += '📍 ' + location + '\n';
  body += '\n――――――――――\n\n';
  displaySections.forEach(([header, items]) => {
    if (!items.length) return;
    body += toBoldSansSerif(header) + '\n' + items.map(b => b.plain ? b.text : b.icon + ' ' + b.text).join('\n') + '\n\n';
  });
  body += '――――――――――\n' + CONTACT_STANDARD;
  return body;
}

// ── The compact layout for a single unit ────────────────────────────────────────────
//   #ForSale $35,000
//
//   📍 Residence L, Boeung Tumpun
//
//   Floor 9 | 📐 47 sqm | 1🛏 | 1🛁
//
//   Features:
//   ✅ ...
//
//   (🔗 page link is added just above the contact block when the page is live)
// Facts are one line, features are the selling points. The building's facility list belongs on the website, so only the first
// FOLD_FACILITIES facilities are folded into the features (set to 0 to leave them out completely). The unit number is never shown.
// The compact layout is OFF until Nick accepts a style. Off means every post keeps the layout it had before (bed and bath emoji line first).
let COMPACT_LISTING_LAYOUT = false;
const FOLD_FACILITIES = 2;
const COMPACT_TEXT = {
  EN: { floor: function (n) { return 'Floor ' + n; }, ground: 'Ground floor', sqm: 'sqm', studio: 'Studio', features: 'Features:', utilities: 'Utilities:', net: function (n) { return 'Net area ' + n + ' sqm'; } },
  JP: { floor: function (n) { return n + '階'; }, ground: 'グラウンドフロア', sqm: '㎡', studio: 'スタジオ', features: '特徴:', utilities: '光熱費:', net: function (n) { return '専有面積 ' + n + '㎡'; } },
  RU: { floor: function (n) { return n + ' этаж'; }, ground: 'Первый этаж', sqm: 'м²', studio: 'Студия', features: 'Особенности:', utilities: 'Коммунальные услуги:', net: function (n) { return 'Чистая площадь ' + n + ' м²'; } },
  DE: { floor: function (n) { return n + '. Etage'; }, ground: 'Erdgeschoss', sqm: 'm²', studio: 'Studio', features: 'Ausstattung:', utilities: 'Nebenkosten:', net: function (n) { return 'Nettofläche ' + n + ' m²'; } },
};
const FLOOR_SEGMENT_RE = /^(?:([0-9]{1,3})(?:st|nd|rd|th)?\s*floor|floor\s*[:#]?\s*([0-9]{1,3}|G))$/i;
const SIZE_SEGMENT_RE = /^([0-9]+(?:[.,][0-9]+)?)\s*(?:㎡|m²|m2|sqm|sq\.?\s?m)\s*(gross|net)?(?:\s*(?:area|size))?$/i;
const UNITNO_SEGMENT_RE = /^unit\s*(?:no\.?|number|#)?\s*[:#-]?\s*[A-Za-z0-9][A-Za-z0-9\-]{0,11}$/i;

function assembleCompactListing(fields, lang, bullets, bedbath, titleEn, locationEn, toLang) {
  const T = COMPACT_TEXT[lang] || COMPACT_TEXT.EN;
  let floor = null, gross = null, net = null, plainSize = null;
  const features = [], facilities = [], utilities = [];
  const seen = {};
  const addTo = function (list, text) {
    const k = String(text).toLowerCase();
    if (text && !seen[k]) { seen[k] = true; list.push(text); }
  };

  bullets.forEach(function (b) {
    if (b.icon !== '✅') { utilities.push(b); return; }
    const left = [];
    String(b.text).split('|').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (seg) {
      let m;
      if ((m = seg.match(FLOOR_SEGMENT_RE))) { if (floor === null) floor = String(m[1] || m[2]).toUpperCase(); return; }
      if ((m = seg.match(SIZE_SEGMENT_RE))) {
        const v = m[1].replace(',', '.'), kind = (m[2] || '').toLowerCase();
        if (kind === 'net') net = net || v; else if (kind === 'gross') gross = gross || v; else plainSize = plainSize || v;
        return;
      }
      if (UNITNO_SEGMENT_RE.test(seg) && /\d/.test(seg)) return; // the unit number stays private
      left.push(seg);
    });
    if (!left.length) return;
    (/^(FACILITIES|AMENITIES)$/i.test(b.section || '') ? facilities : features).push(left.join(' | '));
  });

  const size = gross || plainSize || net;
  const featureLines = [];
  features.forEach(function (f) { addTo(featureLines, toLang(f)); });
  if (net && size !== net) addTo(featureLines, T.net(net));
  facilities.slice(0, FOLD_FACILITIES).forEach(function (f) { addTo(featureLines, toLang(f)); });

  const facts = [];
  if (floor !== null) facts.push(floor === 'G' ? T.ground : T.floor(floor));
  if (size) facts.push('📐 ' + size + ' ' + T.sqm);
  if (bedbath.beds !== null && bedbath.beds !== undefined) facts.push(bedbath.beds === 0 ? T.studio : bedbath.beds + '🛏');
  if (bedbath.baths !== null && bedbath.baths !== undefined) facts.push(bedbath.baths + '🛁');

  // "RESIDENCE L | 1BR UNIT" and "Boeung Tumpun, Phnom Penh" become "Residence L, Boeung Tumpun". Project and place names are never translated.
  const building = titleCaseBuilding(fromBoldSansSerif(String(titleEn || '')).split('|')[0]); // titles arrive in bold letters
  const areaParts = String(locationEn || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (areaParts.length && /^phnom penh$/i.test(areaParts[areaParts.length - 1])) areaParts.pop();
  const where = [building].concat(areaParts).filter(Boolean).join(', ');

  let priceLine = '';
  if (fields.forSale) priceLine += '#ForSale ' + fields.forSale + urgentSuffix(fields, lang) + '\n';
  if (fields.forRent) priceLine += '#ForRent ' + fields.forRent + (fields.forSale ? '' : urgentSuffix(fields, lang)) + '\n';
  let body = priceLine.trim() + '\n\n';
  if (where) body += '📍 ' + where + '\n\n';
  if (facts.length) body += facts.join(' | ') + '\n\n';
  if (featureLines.length) body += T.features + '\n' + featureLines.map(function (f) { return '✅ ' + f; }).join('\n') + '\n\n';
  if (utilities.length) body += T.utilities + '\n' + utilities.map(function (u) { return u.icon + ' ' + toLang(u.text); }).join('\n') + '\n\n';
  body += '――――――――――\n' + CONTACT_STANDARD;
  return body;
}

// ── Bold Sans-Serif Unicode helpers (𝗧𝗜𝗠𝗘 𝗦𝗤𝗨𝗔𝗥𝗘 style headers) ────
//
//   Mathematical Sans-Serif Bold block: A-Z starts at U+1D5D4,
//   a-z starts at U+1D5EE, 0-9 starts at U+1D7EC.

function toBoldSansSerif(str) {
  return str.split('').map(ch => {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));   // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));  // a-z
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));   // 0-9
    return ch;
  }).join('');
}

function fromBoldSansSerif(str) {
  return Array.from(str).map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 0x1D5D4 && code <= 0x1D5ED) return String.fromCharCode(65 + (code - 0x1D5D4)); // A-Z
    if (code >= 0x1D5EE && code <= 0x1D607) return String.fromCharCode(97 + (code - 0x1D5EE)); // a-z
    if (code >= 0x1D7EC && code <= 0x1D7F5) return String.fromCharCode(48 + (code - 0x1D7EC)); // 0-9
    return ch;
  }).join('');
}

// ── Callback handling (Approve / Reject button taps) ──────────────

function handleCallback(cb) {
  const data = cb.data || ''; // "approve_<id>" / "reject_<id>" (single-row, manual Sheet entries) or "approveAll_<sourceId>" / "rejectAll_<sourceId>" (auto-detected listings)
  const sepIdx = data.indexOf('_');
  const action = sepIdx === -1 ? data : data.slice(0, sepIdx);
  const id = sepIdx === -1 ? '' : data.slice(sepIdx + 1);
  Logger.log('handleCallback: raw data="' + data + '" action="' + action + '" id="' + id + '"');

  if (action === 'menu') {
    handleMenuCallback(cb, id); // the "What should I do with this post?" buttons (callback_data "menu_<id>_<verb>")
    return;
  }
  if (action === 'unit') {
    handleUnitCallback(cb, id); // buttons of the website draft (callback_data "unit_<draftId>_<verb>")
    return;
  }
  if (action === 'price') {
    handlePriceCallback(cb, id); // buttons of a price update (callback_data "price_<unitId>_<verb>")
    return;
  }
  if (action === 'ustat') {
    handleUnitStatusCallback(cb, id); // buttons of a sold / rented change (callback_data "ustat_<unitId>_<sold|rented>_<verb>")
    return;
  }
  if (action === 'approveAll' || action === 'rejectAll') {
    handleGroupCallback(cb, action, id);
    return;
  }
  if (action === 'pollApproveAll' || action === 'pollRejectAll') {
    handlePollGroupCallback(cb, action, id);
    return;
  }

  const sheet = getQueueSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const idIdx = headers.indexOf('id');
  const photoIdx = headers.indexOf('photoFileId');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]) !== String(id)) continue;

    const rowNum = i + 1;
    const rowObj = {};
    headers.forEach((h, c) => rowObj[h] = rows[i][c]);
    const photoIds = parsePhotoIds(photoIdx > -1 ? rowObj.photoFileId : '');
    Logger.log('handleCallback: found row ' + rowNum + ', status="' + rowObj.status + '", language="' + rowObj.language + '"');

    if (rowObj.status !== 'Pending Review') {
      answerCallback(cb.id, 'Already handled.');
      return;
    }

    if (action === 'approve') {
      const channelId = LANGUAGE_CHANNELS[rowObj.language];
      Logger.log('handleCallback: approving, channelId=' + channelId + ', photoIds=' + photoIds.length);
      if (!channelId) {
        answerCallback(cb.id, 'No channel configured for language: ' + rowObj.language);
        return;
      }
      const contactKeyboard = getContactKeyboard(rowObj.language);
      let posted;
      if (photoIds.length > 0) {
        posted = postGalleryWithButtons(channelId, photoIds, rowObj.content, contactKeyboard);
      } else {
        posted = sendTelegramMessage(channelId, rowObj.content, contactKeyboard);
      }
      Logger.log('handleCallback: post result=' + JSON.stringify(posted));
      const postedMsgId = Array.isArray(posted) ? (posted[0] && posted[0].message_id) : (posted && posted.message_id);
      sheet.getRange(rowNum, headers.indexOf('status') + 1).setValue('Posted');
      sheet.getRange(rowNum, headers.indexOf('postedMsgId') + 1).setValue(postedMsgId || '');
      sheet.getRange(rowNum, headers.indexOf('postedAt') + 1).setValue(new Date().toISOString());
      finishReviewMessage(cb.message.chat.id, cb.message.message_id, rowObj.content + '\n\n✅ POSTED to ' + rowObj.language, photoIds.length > 0);
      sendTelegramMessage(cb.message.chat.id, '✅ APPROVED — posted to ' + rowObj.language + ' (' + mediaCountText(photoIds) + '):\n"' + rowObj.content + '"');
      answerCallback(cb.id, 'Posted to ' + rowObj.language + '!');
    } else if (action === 'reject') {
      sheet.getRange(rowNum, headers.indexOf('status') + 1).setValue('Rejected');
      finishReviewMessage(cb.message.chat.id, cb.message.message_id, rowObj.content + '\n\n❌ REJECTED', photoIds.length > 0);
      sendTelegramMessage(cb.message.chat.id, '❌ REJECTED:\n"' + rowObj.content + '"');
      answerCallback(cb.id, 'Rejected.');
    }
    return;
  }
  answerCallback(cb.id, 'Row not found.');
}

// Handles "approveAll_<sourceId>" / "rejectAll_<sourceId>" — approving posts
// all 3 language rows sharing that sourceId to their channels in one tap.
function handleGroupCallback(cb, action, sourceId) {
  const sheet = getQueueSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const idIdx = headers.indexOf('id');
  const langIdx = headers.indexOf('language');
  const contentIdx = headers.indexOf('content');
  const statusIdx = headers.indexOf('status');
  const photoIdx = headers.indexOf('photoFileId');
  const entitiesIdx = headers.indexOf('entities');

  const matchingRows = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]).indexOf(sourceId + '-') === 0) matchingRows.push(i + 1);
  }
  if (!matchingRows.length) { answerCallback(cb.id, 'Rows not found.'); return; }
  if (sheet.getRange(matchingRows[0], statusIdx + 1).getValue() !== 'Pending Review') {
    answerCallback(cb.id, 'Already handled.');
    return;
  }

  const hasPhoto = !!(cb.message.photo && cb.message.photo.length);
  const originalText = hasPhoto ? cb.message.caption : cb.message.text;

  if (action === 'approveAll') {
    matchingRows.forEach(rowNum => {
      const language = sheet.getRange(rowNum, langIdx + 1).getValue();
      const content = sheet.getRange(rowNum, contentIdx + 1).getValue();
      const photoIds = parsePhotoIds(photoIdx > -1 ? sheet.getRange(rowNum, photoIdx + 1).getValue() : '');
      const entitiesCell = entitiesIdx > -1 ? sheet.getRange(rowNum, entitiesIdx + 1).getValue() : '';
      let entities = null;
      if (entitiesCell) { try { entities = JSON.parse(entitiesCell); } catch (e) { entities = null; } }
      const channelId = LANGUAGE_CHANNELS[language];
      if (!channelId) { Logger.log('handleGroupCallback: no channel for ' + language); return; }
      const contactKeyboard = getContactKeyboard(language);

      let posted;
      if (photoIds.length > 0) {
        posted = postGalleryWithButtons(channelId, photoIds, content, contactKeyboard, entities);
      } else {
        posted = sendTelegramMessage(channelId, content, contactKeyboard, entities);
      }
      const postedMsgId = Array.isArray(posted) ? (posted[0] && posted[0].message_id) : (posted && posted.message_id);
      sheet.getRange(rowNum, statusIdx + 1).setValue('Posted');
      sheet.getRange(rowNum, headers.indexOf('postedMsgId') + 1).setValue(postedMsgId || '');
      sheet.getRange(rowNum, headers.indexOf('postedAt') + 1).setValue(new Date().toISOString());
    });
    finishReviewMessage(cb.message.chat.id, cb.message.message_id, originalText + '\n\n✅ POSTED to EN + JP + RU + DE', hasPhoto);
    answerCallback(cb.id, 'Posted to EN/JP/RU/DE!');
  } else {
    matchingRows.forEach(rowNum => sheet.getRange(rowNum, statusIdx + 1).setValue('Rejected'));
    finishReviewMessage(cb.message.chat.id, cb.message.message_id, originalText + '\n\n❌ REJECTED', hasPhoto);
    answerCallback(cb.id, 'Rejected.');
  }
}

// ── Polls — Nick sends a native Telegram poll to the bot, it gets
//    translated to EN/JP/RU/DE and posted as real polls in each channel,
//    same review/approve pattern as listings. ──────────────────────

function handleIncomingPoll(chatId, poll) {
  if (String(chatId) !== REVIEWER_CHAT_ID) return; // only from you, in your private chat with the bot

  const question = poll.question;
  const optionTexts = poll.options.map(o => o.text);

  sendTelegramMessage(REVIEWER_CHAT_ID, '📊 Poll detected — generating EN/JP/RU/DE versions for your review...');

  const sourceId = 'P' + Date.now();
  const sheet = getQueueSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  ['EN', 'JP', 'RU', 'DE'].forEach(lang => {
    const translatedQuestion = translateField(question, 'en', lang);
    const translatedOptions = optionTexts.map(t => translateField(t, 'en', lang));
    const content = JSON.stringify({
      question: translatedQuestion,
      options: translatedOptions,
      isAnonymous: poll.is_anonymous !== false,
      allowsMultiple: !!poll.allows_multiple_answers,
    });

    const rowNum = sheet.getLastRow() + 1;
    const row = headers.map(h => {
      if (h === 'id') return sourceId + '-' + lang;
      if (h === 'createdAt') return new Date().toISOString();
      if (h === 'language') return lang;
      if (h === 'content') return content;
      if (h === 'status') return 'Pending Review';
      if (h === 'listingType') return 'poll';
      return '';
    });
    sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
  });

  sendPollReviewMessage(sheet, headers, sourceId, question, optionTexts);
}

function sendPollReviewMessage(sheet, headers, sourceId, question, options) {
  const reviewText = '📊 New poll ready — approving posts to EN + JP + RU + DE\n\n' +
    toBoldSansSerif(question) + '\n\n' +
    options.map((o, i) => (i + 1) + '. ' + o).join('\n');

  const keyboard = { inline_keyboard: [[
    { text: '✅ Approve All', callback_data: 'pollApproveAll_' + sourceId },
    { text: '❌ Reject All', callback_data: 'pollRejectAll_' + sourceId },
  ]] };

  const msg = sendTelegramMessage(REVIEWER_CHAT_ID, reviewText, keyboard);
  if (!msg || !msg.message_id) return;

  const rows = sheet.getDataRange().getValues();
  const idIdx = headers.indexOf('id');
  const reviewIdx = headers.indexOf('reviewMsgId');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]).indexOf(sourceId + '-') === 0) {
      sheet.getRange(i + 1, reviewIdx + 1).setValue(msg.message_id);
    }
  }
}

// Handles "pollApproveAll_<sourceId>" / "pollRejectAll_<sourceId>" — mirrors
// handleGroupCallback's pattern but posts real Telegram polls instead of text.
function handlePollGroupCallback(cb, action, sourceId) {
  const sheet = getQueueSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const idIdx = headers.indexOf('id');
  const langIdx = headers.indexOf('language');
  const contentIdx = headers.indexOf('content');
  const statusIdx = headers.indexOf('status');

  const matchingRows = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]).indexOf(sourceId + '-') === 0) matchingRows.push(i + 1);
  }
  if (!matchingRows.length) { answerCallback(cb.id, 'Poll not found.'); return; }
  if (sheet.getRange(matchingRows[0], statusIdx + 1).getValue() !== 'Pending Review') {
    answerCallback(cb.id, 'Already handled.');
    return;
  }

  if (action === 'pollApproveAll') {
    matchingRows.forEach(rowNum => {
      const language = sheet.getRange(rowNum, langIdx + 1).getValue();
      const contentJson = sheet.getRange(rowNum, contentIdx + 1).getValue();
      let pollData;
      try { pollData = JSON.parse(contentJson); } catch (e) { Logger.log('poll content parse failed: ' + e); return; }
      const channelId = LANGUAGE_CHANNELS[language];
      if (!channelId) { Logger.log('handlePollGroupCallback: no channel for ' + language); return; }
      const posted = sendTelegramPoll(channelId, pollData.question, pollData.options, pollData.isAnonymous, pollData.allowsMultiple);
      sheet.getRange(rowNum, statusIdx + 1).setValue('Posted');
      sheet.getRange(rowNum, headers.indexOf('postedMsgId') + 1).setValue((posted && posted.message_id) || '');
      sheet.getRange(rowNum, headers.indexOf('postedAt') + 1).setValue(new Date().toISOString());
    });
    finishReviewMessage(cb.message.chat.id, cb.message.message_id, cb.message.text + '\n\n✅ POSTED to EN + JP + RU + DE', false);
    answerCallback(cb.id, 'Poll posted to EN/JP/RU/DE!');
  } else {
    matchingRows.forEach(rowNum => sheet.getRange(rowNum, statusIdx + 1).setValue('Rejected'));
    finishReviewMessage(cb.message.chat.id, cb.message.message_id, cb.message.text + '\n\n❌ REJECTED', false);
    answerCallback(cb.id, 'Rejected.');
  }
}

// ── Listing status updates — Nick replies "SOLD" / "RENTED" / "RESERVED" /
//    "REDUCED $X" directly to a listing's review message. The reply is
//    matched back to that listing via reply_to_message.message_id against
//    the reviewMsgId already saved for every row, then the already-POSTED
//    channel messages get edited in place (not reposted) via
//    editMessageText/editMessageCaption. ──────────────────────

const STATUS_LABELS = {
  SOLD: '🔴 SOLD — no longer available',
  RENTED: '🔑 RENTED — no longer available',
  RESERVED: '🟡 RESERVED / Under Offer',
};

function looksLikeStatusKeyword(text) {
  if (!text) return false;
  const upper = text.trim().toUpperCase();
  return !!STATUS_LABELS[upper] || /^REDUCED\b/.test(upper);
}

// Which website unit a channel post belongs to: the number at the end of its page address (or the older "Ref TS10-1021" line).
function unitFromPost(content) {
  const s = String(content || '');
  const r = s.match(/\bRef\s+([A-Za-z][A-Za-z0-9]{0,5}-(\d{4,6}))\b/);
  if (r) return { ref: r[1], id: parseInt(r[2], 10) - 1000 };
  const u = s.match(/propertyhubcambodia\.com\/property\/([a-z0-9-]+)/i);
  const n = u ? u[1].match(/-(\d{4,6})$/) : null;
  if (n) return { ref: null, id: parseInt(n[1], 10) - 1000 };
  return null;
}

function handleStatusReply(chatId, text, replyToMessageId) {
  const upper = text.trim().toUpperCase();
  let banner;
  if (STATUS_LABELS[upper]) {
    banner = STATUS_LABELS[upper];
  } else {
    const extra = text.trim().slice('REDUCED'.length).trim();
    banner = '🟢 PRICE REDUCED' + (extra ? ' — ' + extra : '');
  }

  const sheet = getQueueSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const reviewIdx = headers.indexOf('reviewMsgId');
  const langIdx = headers.indexOf('language');
  const postedMsgIdx = headers.indexOf('postedMsgId');
  const photoIdx = headers.indexOf('photoFileId');
  const contentIdx = headers.indexOf('content');

  const matchingRows = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][reviewIdx]) === String(replyToMessageId)) matchingRows.push(i + 1);
  }
  if (!matchingRows.length) {
    sendTelegramMessage(REVIEWER_CHAT_ID, "🤔 Couldn't find which listing that's replying to — make sure you're replying directly to the original review message (the one with Approve/Reject).");
    return;
  }

  // A post made through the website route carries "Ref TS10-1021", so a "REDUCED $58,500" reply can also offer the
  // website price change (a card with buttons, nothing changes until you tap).
  let websiteChange = null;
  if (!STATUS_LABELS[upper]) {
    const ref = unitFromPost(sheet.getRange(matchingRows[0], contentIdx + 1).getValue());
    const amount = text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?(?![a-z0-9])/i);
    if (ref && amount) websiteChange = { id: ref.id, ref: ref.ref, newPrice: parseMoneyAmount(amount[1], amount[2]) };
  }

  // The same post's Ref decides what else a reply can do. No Ref means a channel only post with no page on the website.
  const postRef = unitFromPost(sheet.getRange(matchingRows[0], contentIdx + 1).getValue());
  let soldChange = null;
  if ((upper === 'SOLD' || upper === 'RENTED') && postRef) soldChange = { verb: upper.toLowerCase(), id: postRef.id, ref: postRef.ref };
  let pageOffer = null; // a channel only post that could become a website page
  if (!postRef && !STATUS_LABELS[upper]) {
    const enRow = matchingRows.filter(function (r) { return sheet.getRange(r, langIdx + 1).getValue() === 'EN'; })[0] || matchingRows[0];
    pageOffer = { content: String(sheet.getRange(enRow, contentIdx + 1).getValue() || ''), photoIds: parsePhotoIds(photoIdx > -1 ? sheet.getRange(enRow, photoIdx + 1).getValue() : ''), amount: text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?(?![a-z0-9])/i) };
  }

  let updatedCount = 0;
  matchingRows.forEach(rowNum => {
    const language = sheet.getRange(rowNum, langIdx + 1).getValue();
    const postedMsgId = sheet.getRange(rowNum, postedMsgIdx + 1).getValue();
    if (!postedMsgId) return; // this language version was rejected, never posted — nothing to edit
    const channelId = LANGUAGE_CHANNELS[language];
    if (!channelId) return;
    const content = sheet.getRange(rowNum, contentIdx + 1).getValue();
    const photoIds = parsePhotoIds(photoIdx > -1 ? sheet.getRange(rowNum, photoIdx + 1).getValue() : '');

    // postGalleryWithButtons puts the caption on the PHOTO message only when
    // there's exactly one photo — everything else (0 photos, or a multi-photo
    // album) carries the caption on a separate plain text message. Editing
    // must match whichever it actually is, or Telegram rejects the call.
    const captionIsOnAPhoto = photoIds.length === 1;
    editPostedMessage(channelId, postedMsgId, banner + '\n\n' + content, captionIsOnAPhoto);
    updatedCount++;
  });

  sendTelegramMessage(REVIEWER_CHAT_ID, updatedCount
    ? '✅ Updated ' + updatedCount + ' posted version(s) to: ' + banner.replace(/^[^\s]+\s/, '')
    : "🤔 Found that listing, but nothing was actually posted for it (all versions were rejected?).");
  if (websiteChange && websiteChange.newPrice > 0 && websiteChange.id > 0) startPriceUpdate(chatId, websiteChange);
  if (soldChange && soldChange.id > 0) startUnitStatus(chatId, soldChange);
  if (!postRef && updatedCount) offerCreatePage(chatId, pageOffer, STATUS_LABELS[upper] ? null : true);
}

function editPostedMessage(chatId, messageId, newText, hasPhoto) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const url = 'https://api.telegram.org/bot' + token + '/' + (hasPhoto ? 'editMessageCaption' : 'editMessageText');
  const payload = { chat_id: chatId, message_id: messageId };
  payload[hasPhoto ? 'caption' : 'text'] = newText;
  // reply_markup intentionally omitted — Telegram leaves existing buttons
  // (Contact Us / More Property / the tracked Telegram link) untouched when
  // it's not included, which is exactly what a status update should do.
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/x-www-form-urlencoded', payload: payload, muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('editPostedMessage failed: ' + resp.getContentText());
  return data.result;
}

// ── Reaction tracking — requires allowed_updates to include
//    message_reaction_count (see checkForUpdates) and the bot to be an
//    admin in each channel. Logs engagement per listing to a "Reactions"
//    sheet — a free, lightweight stand-in for Buffer's paid analytics. ──

function handleReactionUpdate(mrc) {
  const sheet = getQueueSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const postedMsgIdx = headers.indexOf('postedMsgId');
  const contentIdx = headers.indexOf('content');
  const langIdx = headers.indexOf('language');
  const totalReactions = (mrc.reactions || []).reduce((sum, r) => sum + (r.total_count || 0), 0);

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][postedMsgIdx]) === String(mrc.message_id)) {
      logReactionCount(rows[i][langIdx], rows[i][contentIdx], mrc.message_id, totalReactions, mrc.reactions);
      return;
    }
  }
  Logger.log('handleReactionUpdate: no matching listing for message_id=' + mrc.message_id);
}

function logReactionCount(language, content, messageId, totalReactions, reactions) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Reactions');
  if (!sheet) {
    sheet = ss.insertSheet('Reactions');
    const reactionHeaders = ['timestamp', 'language', 'messageId', 'totalReactions', 'breakdown', 'listingSnippet'];
    sheet.getRange(1, 1, 1, reactionHeaders.length).setValues([reactionHeaders]);
    sheet.getRange(1, 1, 1, reactionHeaders.length)
      .setBackground('#0F192E').setFontColor('#ffffff').setFontWeight('bold').setFontSize(10);
    sheet.setFrozenRows(1);
  }
  const breakdown = (reactions || [])
    .map(r => (r.type && (r.type.emoji || r.type.custom_emoji_id || r.type.type)) + ':' + r.total_count)
    .join(', ');
  const snippet = String(content || '').split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 70);
  sheet.appendRow([new Date().toISOString(), language, messageId, totalReactions, breakdown, snippet]);
}

// ── Location pins — CAPABILITY ONLY, not wired into posting yet.
//    sendTelegramLocation() works and is ready to use, but PROJECT_COORDINATES
//    below has no real GPS data in it — filling in fake coordinates would
//    risk sending someone to the wrong building, so it's deliberately left
//    empty rather than guessed. Fill in real lat/long per project (Google
//    Maps → right-click a location → the numbers at the top of the menu),
//    then a listing's title can be matched against this table to attach a
//    real map pin alongside the photos. ──

const PROJECT_COORDINATES = {
  // 'Time Square 9': { lat: 0, lng: 0 }, // TODO: fill in real coordinates before use
};

function sendTelegramLocation(chatId, latitude, longitude) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendLocation', {
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    payload: { chat_id: chatId, latitude: latitude, longitude: longitude },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('sendTelegramLocation failed: ' + resp.getContentText());
  return data.result;
}

// ── Send for review ──────────────────────────────────────────────

// One review message for all 3 language rows sharing a sourceId — shows the
// EN content (the one you can actually read to judge), approving posts all
// 3 to their channels at once instead of 3 separate taps.
function sendCombinedReviewMessage(sheet, headers, sourceId, photoFileIds) {
  const rows = sheet.getDataRange().getValues();
  const idIdx = headers.indexOf('id');
  const langIdx = headers.indexOf('language');
  const contentIdx = headers.indexOf('content');
  const statusIdx = headers.indexOf('status');

  const entitiesIdx = headers.indexOf('entities');
  let enContent = '', enEntities = null;
  const matchingRows = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]).indexOf(sourceId + '-') === 0) {
      matchingRows.push(i + 1);
      if (rows[i][langIdx] === 'EN') {
        enContent = rows[i][contentIdx];
        const cell = entitiesIdx > -1 ? rows[i][entitiesIdx] : '';
        if (cell) { try { enEntities = JSON.parse(cell); } catch (e) { enEntities = null; } }
      }
    }
  }
  if (!matchingRows.length) return;

  // Prefix pushes enContent's start further into the string — any entities
  // (Premium emoji) must shift by the prefix's length or they'll point at
  // the wrong characters once attached to this longer message.
  const prefix = '📝 New listing ready — approving posts to EN + JP + RU + DE\n\n';
  const reviewText = prefix + enContent;
  const shiftedEntities = enEntities ? enEntities.map(e => Object.assign({}, e, { offset: e.offset + prefix.length })) : null;
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve All', callback_data: 'approveAll_' + sourceId },
      { text: '❌ Reject All', callback_data: 'rejectAll_' + sourceId },
    ]],
  };

  const msg = photoFileIds && photoFileIds.length
    ? sendMedia(REVIEWER_CHAT_ID, photoFileIds[0], reviewText, keyboard, shiftedEntities)
    : sendTelegramMessage(REVIEWER_CHAT_ID, reviewText, keyboard, shiftedEntities);

  matchingRows.forEach(rowNum => {
    sheet.getRange(rowNum, statusIdx + 1).setValue('Pending Review');
    sheet.getRange(rowNum, headers.indexOf('reviewMsgId') + 1).setValue(msg && msg.message_id || '');
  });
  return msg;
}

function sendRowForReview(sheet, headers, rowNum) {
  const idIdx = headers.indexOf('id');
  const langIdx = headers.indexOf('language');
  const contentIdx = headers.indexOf('content');
  const statusIdx = headers.indexOf('status');
  const photoIdx = headers.indexOf('photoFileId');

  const row = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  const id = row[idIdx];
  const language = row[langIdx] || 'TEST';
  const content = row[contentIdx];
  const photoIds = parsePhotoIds(photoIdx > -1 ? row[photoIdx] : '');

  const reviewText = '📝 New content ready — ' + language + (photoIds.length > 1 ? ' (' + mediaCountText(photoIds) + ', showing 1st)' : '') + '\n\n' + content;
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: 'approve_' + id },
      { text: '❌ Reject', callback_data: 'reject_' + id },
    ]],
  };

  // Review preview only shows the first photo (Telegram albums can't carry
  // inline buttons) — the final channel post sends all photos as an album.
  const msg = photoIds.length
    ? sendMedia(REVIEWER_CHAT_ID, photoIds[0], reviewText, keyboard)
    : sendTelegramMessage(REVIEWER_CHAT_ID, reviewText, keyboard);

  sheet.getRange(rowNum, statusIdx + 1).setValue('Pending Review');
  sheet.getRange(rowNum, headers.indexOf('reviewMsgId') + 1).setValue(msg && msg.message_id || '');
}

// Run from the menu — picks up any manually-added rows (language + content, no status yet)
function sendForReview() {
  const sheet = getQueueSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const idIdx = headers.indexOf('id');
  const statusIdx = headers.indexOf('status');
  const contentIdx = headers.indexOf('content');
  const createdIdx = headers.indexOf('createdAt');

  let sent = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[contentIdx] && !row[statusIdx]) {
      const rowNum = i + 1;
      if (!row[idIdx]) sheet.getRange(rowNum, idIdx + 1).setValue('C' + Date.now() + i);
      if (!row[createdIdx]) sheet.getRange(rowNum, createdIdx + 1).setValue(new Date().toISOString());
      sendRowForReview(sheet, headers, rowNum);
      sent++;
    }
  }
  SpreadsheetApp.getUi().alert(sent + ' item(s) sent for review.');
}

// ── Telegram API helpers ────────────────────────────────────────

function sendTelegramMessage(chatId, text, replyMarkup, entities) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  if (entities) payload.entities = JSON.stringify(entities); // preserves Premium custom emoji etc. — only valid if text is byte-identical to the message the entities came from

  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('sendMessage failed: ' + resp.getContentText());
  return data.result;
}

function sendTelegramPhoto(chatId, fileId, caption, replyMarkup, entities) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const payload = { chat_id: chatId, photo: fileId, caption: caption };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  if (entities) payload.caption_entities = JSON.stringify(entities);
  if (entities) Logger.log('sendTelegramPhoto: sending caption_entities=' + payload.caption_entities); // TEMP diagnostic

  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendPhoto', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('sendPhoto failed: ' + resp.getContentText());
  else if (entities) Logger.log('sendTelegramPhoto: response entities=' + JSON.stringify(data.result && data.result.caption_entities)); // TEMP diagnostic — confirms what Telegram actually stored
  return data.result;
}

// Posts a real native Telegram poll (not a text message describing one).
// options is a plain array of strings — Telegram polls don't support any
// rich text formatting in the question or options, so there's no bold/
// entity handling to worry about here, unlike listing captions.
function sendTelegramPoll(chatId, question, options, isAnonymous, allowsMultiple) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const payload = {
    chat_id: chatId,
    question: question,
    options: JSON.stringify(options),
    is_anonymous: isAnonymous !== false,
  };
  if (allowsMultiple) payload.allows_multiple_answers = true;

  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendPoll', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('sendPoll failed: ' + resp.getContentText());
  return data.result;
}

// Telegram doesn't support inline buttons on media groups — this is used
// only for the final channel post (no buttons needed there).
function sendTelegramMediaGroup(chatId, fileIds, caption, entities) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const media = fileIds.map((id, i) => {
    const item = { type: isVideoId(id) ? 'video' : 'photo', media: bareFileId(id) };
    if (i === 0) {
      item.caption = caption; // Telegram only shows a caption from the first item
      if (entities) item.caption_entities = entities; // not stringified — nested inside the media JSON below
    }
    return item;
  });

  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMediaGroup', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { chat_id: chatId, media: JSON.stringify(media) },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('sendMediaGroup failed: ' + resp.getContentText());
  return data.result; // array of Message objects, one per photo
}

// Posts a gallery of photos with the caption + Contact Us/More Property
// buttons. Single photo: caption and buttons attach directly to that one
// message — clean, no placeholder, always worked.
//
// Multiple photos: the album carries no caption at all (keeps the grid
// visually intact — no oversized last photo, no split). The full caption
// then goes out as its own plain text message right after, with the
// buttons attached directly to it. Because the caption is always real,
// substantial listing text, it's never empty — so there's nothing here for
// Telegram to silently reject the way it did with earlier attempts:
//   - splitting the last photo out to attach buttons to it directly worked,
//     but visually broke the gallery (rejected 2026-07-21 after live test)
//   - an invisible/whitespace-only placeholder for a buttons-only message
//     was silently dropped by Telegram (confirmed twice, live, 2026-07-21)
// This version needs neither trick — Nick's idea, 2026-07-22.
function postGalleryWithButtons(channelId, photoIds, caption, contactKeyboard, entities) {
  if (photoIds.length === 1) {
    return sendMedia(channelId, photoIds[0], caption, contactKeyboard, entities);
  }
  sendTelegramMediaGroup(channelId, photoIds); // no caption — it goes in its own message below
  return sendTelegramMessage(channelId, caption, contactKeyboard, entities);
}

function getLargestPhotoId(message) {
  if (message.photo && message.photo.length) {
    return message.photo[message.photo.length - 1].file_id; // Telegram lists smallest→largest
  }
  return null;
}

// Videos ride in the same list as photos (the Queue sheet's photoFileId column, album handling, review cards) by putting
// 'v:' in front of the file_id. Rows written before videos were supported have no prefix, so they read exactly as before.
const VIDEO_ID_PREFIX = 'v:';
function isVideoId(id) { return typeof id === 'string' && id.indexOf(VIDEO_ID_PREFIX) === 0; }
function bareFileId(id) { return isVideoId(id) ? id.slice(VIDEO_ID_PREFIX.length) : id; }

// A photo's file_id, or 'v:' + a video's file_id (what the listing flow stores and sends). null when the message has neither.
function getMediaId(message) {
  const photo = getLargestPhotoId(message);
  if (photo) return photo;
  if (message.video && message.video.file_id) return VIDEO_ID_PREFIX + message.video.file_id;
  return null;
}

// Only the real photos of a list (the website photo upload cannot use a video).
function photosOnly(ids) { return (ids || []).filter(function (id) { return !isVideoId(id); }); }

// "3 photos", "1 video", "2 photos and 1 video", "0 photos"
function mediaCountText(ids) {
  const list = ids || [];
  const videos = list.filter(isVideoId).length;
  const photos = list.length - videos;
  const plural = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); };
  if (videos === 0) return plural(photos, 'photo');
  if (photos === 0) return plural(videos, 'video');
  return plural(photos, 'photo') + ' and ' + plural(videos, 'video');
}

// One media message (photo or video) with a caption and optional buttons.
function sendMedia(chatId, id, caption, replyMarkup, entities) {
  return isVideoId(id) ? sendTelegramVideo(chatId, bareFileId(id), caption, replyMarkup, entities) : sendTelegramPhoto(chatId, id, caption, replyMarkup, entities);
}

function sendTelegramVideo(chatId, fileId, caption, replyMarkup, entities) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const payload = { chat_id: chatId, video: fileId, caption: caption, supports_streaming: true };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  if (entities) payload.caption_entities = JSON.stringify(entities);
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendVideo', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) Logger.log('sendVideo failed: ' + resp.getContentText());
  return data.result;
}

// Edits the review message (text or photo caption) once handled, removing the buttons.
function finishReviewMessage(chatId, messageId, newText, hasPhoto) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const url = 'https://api.telegram.org/bot' + token + '/' + (hasPhoto ? 'editMessageCaption' : 'editMessageText');
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: JSON.stringify({ inline_keyboard: [] }),
  };
  payload[hasPhoto ? 'caption' : 'text'] = newText;

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true,
  });
}

function answerCallback(callbackQueryId, text) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { callback_query_id: callbackQueryId, text: text },
    muteHttpExceptions: true,
  });
}

// ── Sheet helpers ────────────────────────────────────────────────

function getQueueSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground('#0F192E').setFontColor('#ffffff').setFontWeight('bold').setFontSize(10);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function initializeAll() {
  const sheet = getQueueSheet();
  Logger.log('✅ Queue ready — rows: ' + sheet.getLastRow());
}

// Run once after adding 'photoFileId' to HEADERS, for sheets created before this existed.
function migrateQueueSchema() {
  const sheet = getQueueSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const toAdd = ['photoFileId', 'listingType', 'entities'].filter(c => !headers.includes(c));
  if (!toAdd.length) {
    Logger.log('✅ Schema already up to date — no migration needed');
    return;
  }
  let nextCol = sheet.getLastColumn() + 1;
  toAdd.forEach(col => {
    sheet.getRange(1, nextCol).setValue(col)
      .setBackground('#0F192E').setFontColor('#ffffff').setFontWeight('bold').setFontSize(10);
    nextCol++;
  });
  Logger.log('✅ Added columns: ' + toAdd.join(', '));
}

// ── Trigger setup (run ONCE) ────────────────────────────────────────

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkForUpdates')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('✅ Trigger installed — checking for messages/button taps every minute.');
}

// ── Menu ─────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PHC Content Bot')
    .addItem('📤 Send New Content for Review', 'sendForReview')
    .addSeparator()
    .addItem('🔧 Set up Queue sheet', 'initializeAll')
    .addItem('🔧 Migrate Queue schema (add photoFileId)', 'migrateQueueSchema')
    .addItem('⚙️ Install / Reset Triggers', 'installTriggers')
    .addToUi();
}


// ═══════════════════════════════════════════════════════════════
//  UNIT INTAKE — Telegram → hidden draft page on the website
//
//  You send a post (photos plus your usual listing format, or a short caption
//  like "#unit 2 bedroom, floor 14, 85 sqm, $185,000"), or forward one.
//  The bot asks ONE question: "What should I do with this post?"
//    Website draft    reads the post, asks only for what is missing, then creates
//                     a HIDDEN draft unit on propertyhubcambodia.com
//    Post to channels the existing flow: EN/JP/RU/DE versions for your approval
//    Both             the draft first; the channel posts come after the page is
//                     live, with its link and reference code
//    Ignore           nothing happens
//  A message with #unit (or #web, or /unit) skips the question and goes straight
//  to the website draft. Plain chat with no photos gets no menu.
//  Nothing is public until you log in to the website as admin and tap
//  "Publish Unit Live", then Confirm.
//
//  Script Properties needed (Project Settings → Script Properties):
//    BOT_TOKEN           (already set)
//    INTAKE_API_SECRET   the same long random value set in Vercel
//    DRY_RUN             optional: "true" = rehearse without uploading
//                        or creating anything (no website calls)
//
//  The photo work runs on the website's server (api/intake-unit),
//  not here: Apps Script cannot resize images.
// ═══════════════════════════════════════════════════════════════

const INTAKE_URL = 'https://www.propertyhubcambodia.com/api/intake-unit';
const SUPABASE_REST_URL = 'https://gqjetqqhcvedqnssbklm.supabase.co/rest/v1';
// Public "publishable" key: the same one the website ships to every browser. Not a secret.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_78bwM2Lar6Hk3wJy2jVMug_Kmheaj15';
const UNIT_PHOTOS_PER_REQUEST = 3;   // keeps each website request short
const UNIT_PARALLEL_BATCHES = 4;     // how many photo requests go out at the same time
const UNIT_MAX_PHOTOS = 40;
const UNIT_CACHE_SECONDS = 21600;    // a draft in progress is kept for 6 hours (Apps Script cache maximum)

// Worded exactly like the facility names already on the live site.
const UNIT_FACILITIES = [
  '24-Hour Security', 'Fitness Centre', 'Swimming Pool', 'High-Speed Lifts', 'Covered Parking',
  'Backup Generator', 'Concierge Service', 'Sky Lounge', 'Rooftop Garden', 'CCTV',
];

function isUnitIntakeText(text) {
  return /(^|\s)(#unit|#web|\/unit)(?![A-Za-z0-9_])/i.test(String(text || ''));
}

// Largest photo, OR an image sent "as a file" (document). Used only by the unit intake;
// the normal listing flow still uses getLargestPhotoId (unchanged).
function getImageFileId(m) {
  if (m.photo && m.photo.length) return m.photo[m.photo.length - 1].file_id;
  const d = m.document;
  if (d && d.file_id) {
    const mime = String(d.mime_type || '').toLowerCase();
    const name = String(d.file_name || '').toLowerCase();
    if (isHeicDocument(d)) return null; // the website cannot use iPhone HEIC files, see warnAboutHeic
    if (mime.indexOf('image/') === 0 || /\.(jpe?g|png|webp)$/.test(name)) return d.file_id;
  }
  return null;
}

// iPhone's own picture format. Telegram turns it into a JPEG when you send it as a Photo, but not when you send it as a File.
function isHeicDocument(d) {
  if (!d) return false;
  const mime = String(d.mime_type || '').toLowerCase();
  const name = String(d.file_name || '').toLowerCase();
  return /image\/hei[cf]/.test(mime) || /\.hei[cf]$/.test(name);
}

// Tells you once a minute that HEIC files were skipped (an album of ten would otherwise send ten messages).
function warnAboutHeic(m) {
  if (!m || !isHeicDocument(m.document) || !m.chat) return;
  const chatId = String(m.chat.id);
  if (chatId !== REVIEWER_CHAT_ID) return;
  const key = 'heicwarn_' + chatId;
  if (unitCache().get(key)) return;
  unitCache().put(key, '1', 60);
  sendTelegramMessage(chatId,
    'Some of your pictures are HEIC files (the iPhone format). The website cannot use them, so I skipped them.\n' +
    'Send those again as Photos, not as Files. Or on the iPhone open Settings, Camera, Formats and choose Most Compatible.');
}

// Pulls the facts out of the caption. Returns nulls for anything it cannot find.
// PHC uses sqm only: a size given in square feet is NOT converted, it is flagged.
function parseUnitText(text) {
  const out = { price: null, bedrooms: null, bathrooms: null, sqm: null, floor: null, unitNumber: null, video: null, listingType: 'resale', usedSqft: false };
  let t = String(text || '').replace(/#(?:unit|web)(?![A-Za-z0-9_])/ig, ' ').replace(/(^|\s)\/unit(?![A-Za-z0-9_])/ig, ' ');

  const yt = t.match(/(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (yt) out.video = 'https://www.youtube.com/watch?v=' + yt[1];
  t = t.replace(/(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/\S+/ig, ' ').replace(/https?:\/\/\S+/ig, ' ');

  // Rent only when the post says so ("for rent", #rent) or when the PRICE itself is per month (checked below, right
  // after the price is read). A monthly instalment, rental income or a current tenant's rent ("$368/ month") must
  // never turn a sale into a rental.
  if (/#rent\b|for\s+rent/i.test(t)) out.listingType = 'rent';

  let pm = t.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM])?/) || t.match(/\bprice\s*[:=]?\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM])?/i) || t.match(/\b([0-9][0-9,]{3,})\s*(?:usd|dollars?)\b/i);
  if (pm) {
    let p = parseFloat(String(pm[1]).replace(/,/g, ''));
    const mult = (pm[2] || '').toLowerCase();
    if (mult === 'k') p *= 1000;
    if (mult === 'm') p *= 1000000;
    if (p > 0) out.price = Math.round(p);
    if (/^\s*(?:\/|per\s+|a\s+)\s*(?:month|mo)\b/i.test(t.slice(pm.index + pm[0].length))) out.listingType = 'rent';
  }

  if (/\bstudio\b/i.test(t)) out.bedrooms = 0;
  const bm = t.match(/(\d+)\s*[- ]?(?:bed(?:room)?s?|br|bd)\b/i);
  if (bm) out.bedrooms = parseInt(bm[1], 10);

  const bam = t.match(/(\d+)\s*[- ]?(?:bath(?:room)?s?|ba)\b/i);
  if (bam) out.bathrooms = parseInt(bam[1], 10);

  const sm = t.match(/(\d+(?:\.\d+)?)\s*(?:sqm|sq\.?\s?m\b|m2|m²|square\s*met(?:er|re)s?)/i);
  if (sm) out.sqm = Math.round(parseFloat(sm[1]));
  if (/\d\s*(?:sqft|sq\.?\s?ft|square\s*feet|ft2)\b/i.test(t)) out.usedSqft = true;

  const fm = t.match(/\bfloor\s*#?\s*([0-9]{1,3}|G)\b/i) || t.match(/\b([0-9]{1,3})(?:st|nd|rd|th)\s+floor\b/i);
  if (fm) out.floor = String(fm[1]).toUpperCase();

  const um = t.match(/\bunit\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\-]{0,9})/i);
  if (um && /\d/.test(um[1])) out.unitNumber = um[1].toUpperCase();

  return out;
}

// ── Draft state (kept in the script cache between taps) ─────────────

function unitCache() { return CacheService.getScriptCache(); }

function saveUnitDraft(d) {
  unitCache().put('unitdraft_' + d.id, JSON.stringify(d), UNIT_CACHE_SECONDS);
}

function loadUnitDraft(id) {
  const raw = unitCache().get('unitdraft_' + id);
  return raw ? JSON.parse(raw) : null;
}

// A "session" is open from the #unit message until the draft is created or cancelled
// (or 10 minutes after the last tap). While it is open, checkForUpdates listens continuously.
const UNIT_SESSION_SECONDS = 600;
const UNIT_FAST_MODE_MS = 240000;
function unitSessionTouch() { unitCache().put('unitsession', '1', UNIT_SESSION_SECONDS); }
function unitSessionEnd() { unitCache().remove('unitsession'); }
function isUnitSessionActive() { return !!unitCache().get('unitsession'); }

function newUnitDraftId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 6);
}

function isUnitDryRun() {
  return String(PropertiesService.getScriptProperties().getProperty('DRY_RUN') || '').toLowerCase() === 'true';
}

// ── Talking to the website ──────────────────────────────────────────

// Returns { code, body }. In DRY_RUN nothing leaves Apps Script.
function callIntake(payload) {
  if (isUnitDryRun()) return dryRunIntake(payload);
  const secret = PropertiesService.getScriptProperties().getProperty('INTAKE_API_SECRET');
  if (!secret) return { code: 503, body: { ok: false, error: 'no_secret' } };
  const resp = UrlFetchApp.fetch(INTAKE_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  let body = null;
  try { body = JSON.parse(resp.getContentText()); } catch (e) { body = { ok: false, error: 'non_json' }; }
  return { code: resp.getResponseCode(), body: body };
}


// Several requests at once. Results come back in the same order as the payloads.
function callIntakeMany(payloads) {
  if (isUnitDryRun()) return payloads.map(dryRunIntake);
  const secret = PropertiesService.getScriptProperties().getProperty('INTAKE_API_SECRET');
  if (!secret) return payloads.map(function () { return { code: 503, body: { ok: false, error: 'no_secret' } }; });
  const responses = UrlFetchApp.fetchAll(payloads.map(function (p) {
    return { url: INTAKE_URL, method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + secret }, payload: JSON.stringify(p), muteHttpExceptions: true };
  }));
  return responses.map(function (resp) {
    let body = null;
    try { body = JSON.parse(resp.getContentText()); } catch (e) { body = { ok: false, error: 'non_json' }; }
    return { code: resp.getResponseCode(), body: body };
  });
}

function dryRunIntake(payload) {
  if (payload.action === 'prepare') {
    const rooms = payload.bedrooms === null || payload.bedrooms === undefined ? '' : ' · ' + (payload.bedrooms <= 0 ? 'Studio' : payload.bedrooms + ' Bedroom');
    const title = (payload.buildingName || 'Linked project') + rooms + (payload.floor ? ' · Floor ' + payload.floor : '');
    return { code: 200, body: { ok: true, title: title, slug: 'dry-run-' + Utilities.getUuid().slice(0, 4) } };
  }
  if (payload.action === 'photos') {
    return { code: 200, body: { ok: true, urls: payload.fileIds.map(function (f, i) { return 'dry-run-photo-' + (payload.startIndex + i + 1); }) } };
  }
  if (payload.action === 'create') {
    return { code: 200, body: { ok: true, id: 0, slug: 'dry-run', refCode: 'DRY-RUN', previewUrl: 'DRY RUN (no page was created)' } };
  }
  if (payload.action === 'lookup') {
    return { code: 200, body: { ok: true, id: payload.id, title: 'Dry Run Tower · 1 Bedroom · Floor 6', price: 62000, status: 'active', listingType: 'resale', bedrooms: 1, bathrooms: 1, sqm: 40, floor: '6', location: 'BKK1', city: 'Phnom Penh', refCode: 'DRT-' + (payload.id + 1000), url: 'DRY RUN (no page)' } };
  }
  if (payload.action === 'twins') return { code: 200, body: { ok: true, twins: [] } };
  if (payload.action === 'price') return { code: 200, body: { ok: true, id: payload.id, oldPrice: payload.expectedOldPrice, newPrice: payload.newPrice } };
  if (payload.action === 'status') return { code: 200, body: { ok: true, id: payload.id, status: payload.newStatus } };
  return { code: 200, body: { ok: true, removed: 0 } };
}

// Active projects (not units) for the building picker, cached for an hour.
function fetchUnitProjects() {
  const cached = unitCache().get('unitprojects');
  if (cached) return JSON.parse(cached);
  const resp = UrlFetchApp.fetch(SUPABASE_REST_URL + '/properties?select=id,title,location,city&parent_property_id=is.null&order=title.asc', {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + SUPABASE_PUBLISHABLE_KEY },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) return [];
  const list = JSON.parse(resp.getContentText()).map(function (r) { return { id: r.id, title: r.title, location: r.location || '', city: r.city || '' }; });
  unitCache().put('unitprojects', JSON.stringify(list), 3600);
  return list;
}

// Friendly text for a failed website call.
function describeIntakeFailure(res, what) {
  const b = res.body || {};
  if (res.code === 503) return 'The website intake is not switched on yet (secrets missing in Vercel or Script Properties).';
  if (res.code === 401) return 'The website rejected the secret. INTAKE_API_SECRET must be identical in Vercel and here.';
  const n = typeof b.failedIndex === 'number' ? ' (photo ' + (b.failedIndex + 1) + ')' : '';
  if (b.error === 'file_too_large' || b.error === 'telegram_getfile') return 'A photo could not be read' + n + ': Telegram only lets the bot download files up to 20 MB. Send that one again as a normal photo or a smaller file.';
  if (b.error === 'unsupported_image') return 'A photo' + n + ' is not a JPEG or PNG (iPhone HEIC files are not supported). Send it again as a normal photo.';
  if (b.error === 'title_taken') return 'Another listing took that page address a moment ago. Tap Create draft page again.';
  if (b.error === 'parent_not_found') return 'That building is no longer an active project on the website.';
  return 'The website could not ' + what + ' (' + (b.error || 'HTTP ' + res.code) + ').';
}

// ── Reading your Telegram post format ───────────────────────────────
//
//  Reads the same template you already post, e.g.
//    #ForSale $35,000 / RESIDENCE L | 1BR UNIT / 📍 Boeung Tumpun, Phnom Penh /
//    UNIT DETAILS (✅ bullets) / FACILITIES (✅ bullets) / contact block
//  and fills in everything it can find. Anything it cannot find is asked for later, or left for you to
//  review on the draft page. The contact block is always ignored.

const UNIT_TYPES = ['Condo', 'Apartment', 'Villa / House', 'Commercial', 'Land', 'Serviced Residence'];
const UNIT_AREAS = ['BKK1', 'BKK3', 'Toul Kork', 'Tonle Bassac', 'Daun Penh', 'Other'];
const UNIT_CITIES = { 'phnom penh': 'Phnom Penh', 'siem reap': 'Siem Reap', 'sihanoukville': 'Sihanoukville', 'preah sihanouk': 'Sihanoukville', 'kampot': 'Kampot', 'kep': 'Kep', 'battambang': 'Battambang', 'kandal': 'Kandal' };

// "RESIDENCE L" and "sky villa" become "Residence L" and "Sky Villa". Mixed-case names are kept as typed.
function titleCaseBuilding(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (n !== n.toUpperCase() && n !== n.toLowerCase()) return n;
  return n.toLowerCase().split(' ').map(function (w) {
    if (/\d/.test(w) || w.length <= 2) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function formatUsd(n) {
  return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Property type from words in the title or a short caption. Never from facility bullets
// ("office", "retail", "coffee shop" there must not turn a condo into a commercial unit).
function guessUnitType(text) {
  const t = String(text || '');
  // The specific word wins over the generic one ("BOREY | SHOPHOUSE" is a shophouse).
  if (/\b(shop\s?house|shophouse|office|retail|warehouse|commercial)\b/i.test(t)) return 'Commercial';
  if (/\b(land|plot|hectare)\b/i.test(t)) return 'Land';
  if (/\b(villa|town\s?house|twin villa|link house|flat house|borey)\b/i.test(t)) return 'Villa / House';
  if (/\b(serviced|hotel|grr)\b/i.test(t)) return 'Serviced Residence';
  if (/\bapartment\b/i.test(t)) return 'Apartment';
  if (/\bcondo(minium)?\b/i.test(t)) return 'Condo';
  return null;
}

function readPriceLine(line, out) {
  const firstPrice = out.price === null; // only the main price can say "per month"
  let tail = '';
  const arrow = line.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:→|->|=>|➡️?|➜|to)\s*\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (arrow) {
    const from = Math.round(parseFloat(arrow[1].replace(/,/g, '')));
    const to = Math.round(parseFloat(arrow[2].replace(/,/g, '')));
    out.priceChange = { from: from, to: to };
    out.price = to;
    tail = line.slice(arrow.index + arrow[0].length);
  } else {
    const m = line.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM])?/);
    if (m && out.price === null) {
      let p = parseFloat(m[1].replace(/,/g, ''));
      const mult = (m[2] || '').toLowerCase();
      if (mult === 'k') p *= 1000;
      if (mult === 'm') p *= 1000000;
      if (p > 0) out.price = Math.round(p);
    }
    if (m) tail = line.slice(m.index + m[0].length);
  }
  // Rent only when the line says so ("For Rent", "Rental Price:") or the main price is per month.
  const priceIsMonthly = firstPrice && /^\s*(?:\/|per\s+|a\s+)\s*(?:month|mo)\b/i.test(tail);
  if (/#ForRent|for\s+rent/i.test(line) || /\b(?:rental|rent)(?:\s*price)?\s*[:=]/i.test(line) || priceIsMonthly) out.listingType = 'rent';
  else if (/#ForSale|selling price|for\s+sale|\bresale\b/i.test(line) && out.listingType === null) out.listingType = 'resale';
}

function addUnitFeature(out, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!t) return;
  const low = t.toLowerCase();
  for (let i = 0; i < out.extraFeatures.length; i++) { if (out.extraFeatures[i].toLowerCase() === low) return; }
  if (out.extraFeatures.length < 30) out.extraFeatures.push(t);
}

// One piece of a details bullet (bullets can hold several pieces separated by "|").
// Returns true when the piece was a structured fact; false means it is a plain feature.
function applyDetailSegment(seg, out) {
  let m;
  seg = String(seg).replace(/^[\u{1F6CF}\u{1F6C1}\u{1F4D0}\uFE0F\s]+/u, '');
  if ((m = seg.match(/^([0-9]+)\s*\u{1F6CF}\uFE0F?$/u))) { out.bedrooms = parseInt(m[1], 10); return true; } // "2🛏" in the compact line
  if ((m = seg.match(/^([0-9]+(?:[.,][0-9]+)?)\s*\u{1F6C1}\uFE0F?$/u))) { out.bathrooms = parseFloat(m[1].replace(',', '.')); return true; }
  if ((m = seg.match(/^unit\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\-]{0,11})$/i)) && /\d/.test(m[1])) { out.unitNumber = m[1].toUpperCase(); return true; }
  if ((m = seg.match(/^(?:([0-9]{1,3})(?:st|nd|rd|th)?\s*floor|floor\s*[:#]?\s*([0-9]{1,3}|G))$/i))) { out.floor = String(m[1] || m[2]).toUpperCase(); return true; }
  if (/^studio$/i.test(seg)) { out.bedrooms = 0; return true; }
  if ((m = seg.match(/^([0-9]+)\s*[- ]?(?:bed(?:room)?s?|br)\b/i))) { out.bedrooms = parseInt(m[1], 10); return true; }
  if ((m = seg.match(/^([0-9]+(?:[.,][0-9]+)?)\s*[- ]?bath(?:room)?s?\b/i))) { out.bathrooms = parseFloat(m[1].replace(',', '.')); return true; }
  if ((m = seg.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(?:㎡|m²|m2|sqm|sq\.?\s?m)\s*(gross|net)?$/i))) {
    const v = Math.round(parseFloat(m[1].replace(',', '.')));
    const kind = (m[2] || '').toLowerCase();
    if (kind === 'gross') out.grossSqm = v; else if (kind === 'net') out.netSqm = v; else out.sqm = v;
    return true;
  }
  if (/^[0-9]+(?:[.,][0-9]+)?\s*(?:sqft|sq\.?\s?ft|square\s*feet|ft2)\b/i.test(seg)) { out.usedSqft = true; return true; }
  return false;
}

// "Boeung Tumpun, Phnom Penh" -> location "Boeung Tumpun", city "Phnom Penh".
function readLocation(loc, out) {
  const parts = String(loc || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1].toLowerCase() : '';
  if (UNIT_CITIES[last]) { out.city = UNIT_CITIES[last]; parts.pop(); }
  out.locationText = parts.length ? parts.join(', ') : null;
}

// One "Label: value" line. Returns true when the label is one we understand.
function applyLabelValue(label, value, out) {
  let m;
  if (/^(floor|level|storey)$/.test(label)) {
    m = value.match(/^([0-9]{1,3})(?:st|nd|rd|th)?$/i) || value.match(/^(G)$/i);
    if (m) { out.floor = String(m[1]).toUpperCase(); return true; }
    return false;
  }
  if (/^(unit|unit no\.?|unit number|room|room no\.?)$/.test(label)) { if (/\d/.test(value)) out.unitNumber = value.toUpperCase().slice(0, 12); return true; }
  if (/^(bedrooms?|beds?|bedroom type)$/.test(label)) {
    if (/studio/i.test(value)) out.bedrooms = 0;
    else if ((m = value.match(/(\d+)/))) out.bedrooms = parseInt(m[1], 10);
    return true;
  }
  if (/^(bathrooms?|baths?)$/.test(label)) { if ((m = value.match(/(\d+)/))) out.bathrooms = parseInt(m[1], 10); return true; }
  if (/^(gross( size| area)?|net( size| area)|size|unit size|floor area|area)$/.test(label)) {
    const kind = /net/.test(label) ? ' net' : (/gross/.test(label) ? ' gross' : '');
    if (applyDetailSegment(value + kind, out)) return true;
    if (/^[0-9]+(?:[.,][0-9]+)?$/.test(value)) { return applyDetailSegment(value + ' sqm' + kind, out); }
    if (label === 'area' && out.locationText === null) { readLocation(value, out); return true; }
    return false;
  }
  if (/^(price|selling price|asking price|rental price|rent|rental)$/.test(label)) {
    m = value.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM])?/);
    if (m && out.price === null) {
      let p = parseFloat(m[1].replace(/,/g, ''));
      const mult = (m[2] || '').toLowerCase();
      if (mult === 'k') p *= 1000;
      if (mult === 'm') p *= 1000000;
      if (p > 0) out.price = Math.round(p);
    }
    if (/rent/.test(label) || /\/\s*month|per\s+month/i.test(value)) out.listingType = 'rent';
    return true;
  }
  if (/^(project|building|property|development|name)$/.test(label)) { out.buildingName = titleCaseBuilding(value); return true; }
  if (/^(location|address|district|neighbou?rhood)$/.test(label)) { readLocation(value, out); return true; }
  if (/^(facing|view|views|direction|orientation|furnished|furnishing|furniture|handover|completion|availability|available|parking|balcony|ownership|tenure|title)$/.test(label)) {
    addUnitFeature(out, label.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + ': ' + value);
    return true;
  }
  return false;
}

// A project from the site named anywhere in the post ("Time Square 10 resale ..."). Exactly one must match.
function findProjectInText(text, projects) {
  const t = String(text || '');
  const hits = (projects || []).filter(function (p) {
    const words = String(p.title).trim().split(/\s+/).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    if (!words.length) return false;
    return new RegExp('(^|[^A-Za-z0-9])' + words.join('[\\s\\-]*') + '(?![A-Za-z0-9])', 'i').test(t);
  });
  return hits.length === 1 ? hits[0] : null;
}

// Inside a payment plan, a line that starts like a normal field ends the block ("Price $49,999", "Floor: 6", "#ForSale ...").
function endsPaymentBlock(line) {
  return /^\s*(?:price|selling price|asking price|floor|level|gross|net|size|area|bed|bath|unit|location|address|project|building|facing|view|furnish|handover|completion|#for(?:sale|rent)|#newproject|📍|💰)/i.test(line);
}

function parseTelegramPost(text) {
  const out = {
    found: false, buildingName: null, bedrooms: null, bathrooms: null, grossSqm: null, netSqm: null, sqm: null,
    floor: null, unitNumber: null, price: null, priceChange: null, listingType: null,
    locationText: null, city: null, extraFeatures: [], propertyType: null, usedSqft: false, paymentFound: false,
  };
  const plain = fromBoldSansSerif(String(text || ''));
  const lines = plain.split('\n').map(function (l) { return l.trim(); });
  const contactRe = /t\.me\/|wa\.me\/|whatsapp|telegram|@\w+|https?:\/\/|www\.|^(?:📞|📱|☎|✆|📧|✉|🏠|🌐|🔗|🏷)/iu;
  const bulletRe = /^(?:✅|✓|✔️?|☑️?|•|●|▪️?|■|★|➡️?|⁃|-|\u{1F6CF}\uFE0F?|\u{1F6C1})\s*/u;
  let section = '';
  let titleText = '';
  let titleDone = false;
  let compactFacts = false;
  let bulletCount = 0;

  lines.forEach(function (line) {
    if (!line) return;
    if (/^[―\-_=⎯—]{3,}$/.test(line)) return;
    if (contactRe.test(line)) return;

    if (/^(?:unit details|details|facilities|features|amenities|utilities)\s*:?$/i.test(line)) { section = line.toLowerCase().replace(/\s*:\s*$/, ''); return; }

    // "Payment Plans:" and everything after it (deposit, instalments, handover payment) stays off the page.
    if (/^[•\-*\s]*payment\s*(?:plans?|terms?|schedule)\b/i.test(line)) { section = 'payment'; out.paymentFound = true; return; }
    if (section === 'payment') { if (endsPaymentBlock(line)) section = ''; else return; }

    if (/#ForSale|#ForRent|#NewProject/i.test(line) || /^💰/u.test(line) || (/\b(price|rent)\b/i.test(line) && /\$/.test(line))) {
      readPriceLine(line, out);
      titleText += ' ' + line.replace(/\$[0-9,.]+/g, '');
      out.found = true;
      return;
    }

    if (/^📍/u.test(line)) {
      readLocation(line.replace(/^📍\s*/u, '').trim(), out);
      out.found = true;
      return;
    }

    // "Label: value" lines (Floor: 6, Gross Size: 40 Sqm, Facing: East ...). Unknown labels are ignored.
    const lv = line.match(/^([A-Za-z][A-Za-z .\/&]{1,24}?)\s*[:：]\s*(\S.*)$/);
    if (lv && !bulletRe.test(line) && applyLabelValue(lv[1].trim().toLowerCase(), lv[2].trim(), out)) { out.found = true; return; }

    const bm = line.match(bulletRe);
    if (bm) {
      bulletCount++;
      out.found = true;
      const content = line.slice(bm[0].length).trim();
      if (!content) return;
      if (/^(?:facilities|features|amenities|utilities)/.test(section)) { addUnitFeature(out, content); return; }
      content.split('|').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (seg) {
        if (!applyDetailSegment(seg, out)) addUnitFeature(out, seg);
      });
      return;
    }

    // The compact facts line, "Floor 9 | 📐 47 sqm | 1🛏 | 1🛁": every part must be a fact we understand.
    if (line.indexOf('|') !== -1) {
      const segs = line.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
      const probe = { bedrooms: null, bathrooms: null, floor: null, grossSqm: null, netSqm: null, sqm: null, unitNumber: null, usedSqft: false };
      if (segs.length >= 2 && segs.every(function (x) { return applyDetailSegment(x, probe); })) {
        segs.forEach(function (x) { applyDetailSegment(x, out); });
        out.found = true;
        compactFacts = true;
        return;
      }
    }

    // The title line, "BUILDING | 1BR UNIT": only trusted when it has a "|".
    if (!titleDone && line.indexOf('|') !== -1) {
      titleDone = true;
      out.found = true;
      const parts = line.split('|');
      out.buildingName = titleCaseBuilding(parts[0]);
      const rest = parts.slice(1).join(' ');
      titleText += ' ' + rest;
      let m;
      if (/\bstudio\b/i.test(rest)) out.bedrooms = 0;
      else if ((m = rest.match(/([0-9]+)\s*[- ]?(?:br|bed(?:room)?s?)\b/i))) out.bedrooms = parseInt(m[1], 10);
      if (/for\s+rent|\brental\b/i.test(rest)) out.listingType = 'rent';
      else if (/\bresale\b|for\s+sale/i.test(rest) && out.listingType === null) out.listingType = 'resale';
    }
  });

  // Compact layout: the first part of the "📍" line is the building ("Residence L, Boeung Tumpun").
  if (compactFacts && !titleDone && out.locationText) {
    const parts = out.locationText.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    out.buildingName = titleCaseBuilding(parts[0]);
    out.locationText = parts.slice(1).join(', ') || null;
  }
  out.sqm = out.grossSqm !== null ? out.grossSqm : (out.sqm !== null ? out.sqm : out.netSqm);
  if (out.grossSqm !== null && out.netSqm !== null) addUnitFeature(out, 'Net area ' + out.netSqm + ' sqm');
  out.propertyType = guessUnitType(titleText);
  if (bulletCount === 0 && !out.buildingName && out.price === null) out.found = false;
  return out;
}

// Short caption and full post, merged. The full post wins where it has an answer.
// The payment plan block (from its heading to the next normal field) is dropped before the short-caption reader looks at the post.
function withoutPaymentPlan(text) {
  const out = [];
  let inPayment = false;
  String(text || '').split('\n').forEach(function (line) {
    if (/^[•\-*\s]*payment\s*(?:plans?|terms?|schedule)\b/i.test(line)) { inPayment = true; return; }
    if (inPayment && endsPaymentBlock(line)) inPayment = false;
    if (!inPayment) out.push(line);
  });
  return out.join('\n');
}

function parseUnitFacts(text) {
  const base = parseUnitText(withoutPaymentPlan(text));
  const full = parseTelegramPost(text);
  const facts = Object.assign({}, base);
  ['price', 'bedrooms', 'bathrooms', 'floor', 'unitNumber', 'listingType'].forEach(function (k) {
    if (full[k] !== null && full[k] !== undefined) facts[k] = full[k];
  });
  if (full.sqm !== null) facts.sqm = full.sqm;
  facts.usedSqft = !!(base.usedSqft || full.usedSqft);
  facts.buildingName = full.buildingName;
  facts.locationText = full.locationText;
  facts.city = full.city;
  facts.extraFeatures = full.extraFeatures;
  facts.priceChange = full.priceChange;
  facts.paymentFound = full.paymentFound;
  facts.isFullPost = full.found;
  facts.propertyType = full.propertyType || (full.found ? null : guessUnitType(text));
  return facts;
}

// A building name from a post matched to an active project on the website.
function matchUnitProject(name, projects) {
  const norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); };
  const n = norm(name);
  if (!n) return null;
  let hit = null;
  (projects || []).forEach(function (p) { if (!hit && norm(p.title) === n) hit = p; });
  if (hit) return hit;
  const loose = (projects || []).filter(function (p) {
    const pn = norm(p.title);
    return n.length >= 5 && pn.length >= 5 && (pn.indexOf(n) !== -1 || n.indexOf(pn) !== -1);
  });
  return loose.length === 1 ? loose[0] : null;
}

// ── The menu: what should the bot do with this post? ────────────────

function looksLikeListingText(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return /#ForSale|#ForRent|#NewProject/i.test(t) || /\[\s*for\s+(sale|rent)\s*\]/i.test(t) ||
    (/[一-鿿]/.test(t) && /\$[\d,]+/.test(t)) || hasListingVocabulary(t) || parseTelegramPost(t).found;
}

function menuCache(id) { return 'unitmenu_' + id; }
function loadUnitMenu(id) { const raw = unitCache().get(menuCache(id)); return raw ? JSON.parse(raw) : null; }
function saveUnitMenu(m) { unitCache().put(menuCache(m.id), JSON.stringify(m), UNIT_CACHE_SECONDS); }

// Returns true when it handled the message (so the old listing flow must not also run on it).
function routeIncoming(chatId, text, photoFileIds, isForwarded, sourceUsername, originalEntities, imageFileIds, mediaGroupId) {
  chatId = String(chatId);
  text = String(text || '');
  let images = (imageFileIds && imageFileIds.length ? imageFileIds : photosOnly(photoFileIds)).slice(0, UNIT_MAX_PHOTOS);
  let photoIds = (photoFileIds || []).slice(0, UNIT_MAX_PHOTOS);
  const orig = { text: text, photoIds: photoIds, isForwarded: !!isForwarded, sourceUsername: sourceUsername || null, entities: originalEntities || null };

  // 1. a typed answer to "What is the building called?" or "Which area?"
  if (isAwaitingUnitText(chatId, text, isForwarded)) { handleUnitTextReply(chatId, text); return true; }

  // 2. the tag skips the question: straight to a website draft
  if (isUnitIntakeText(text)) { startWebsiteDraft(chatId, text, images, mediaGroupId, orig, 'site'); return true; }

  // 2b. a price change for a unit that is already on the website ("TS10-1021 price reduced to $58,500")
  const priceChange = parsePriceUpdate(text);
  if (priceChange) { startPriceUpdate(chatId, priceChange); return true; }
  const statusChange = parseUnitStatusText(text);
  if (statusChange) { startUnitStatus(chatId, statusChange); return true; }

  // 3. photos sent earlier without any text, now followed by the post text
  //    (a post longer than Telegram's 1,024 character caption limit has to go as a separate message)
  const pendingRaw = unitCache().get('unitpending_' + chatId);
  const pending = pendingRaw ? JSON.parse(pendingRaw) : null;
  if (pending && !images.length && looksLikeListingText(text)) {
    images = pending.images; photoIds = pending.photoIds; orig.photoIds = photoIds;
    unitCache().remove('unitpending_' + chatId);
    askRouteMenu(chatId, orig, images, mediaGroupId);
    return true;
  }

  // 4. photos with no text at all: keep them and wait for the text
  if (images.length && !text.trim() && !isForwarded) {
    const all = pending ? { images: pending.images.concat(images), photoIds: pending.photoIds.concat(photoIds) } : { images: images, photoIds: photoIds };
    all.images = all.images.slice(0, UNIT_MAX_PHOTOS); all.photoIds = all.photoIds.slice(0, UNIT_MAX_PHOTOS);
    unitCache().put('unitpending_' + chatId, JSON.stringify(all), 600);
    unitSessionTouch();
    sendTelegramMessage(chatId, 'Got ' + all.images.length + ' photo' + (all.images.length === 1 ? '' : 's') + '. Now send the post text (within 10 minutes) and I will ask what to do with it. You can also add #unit to a caption to go straight to a website draft.');
    return true;
  }

  // 5. anything that looks like a listing, or carries photos, or was forwarded: ask
  if (images.length || isForwarded || looksLikeListingText(text)) { askRouteMenu(chatId, orig, images, mediaGroupId); return true; }

  return false; // plain chat: the old behaviour (silent)
}

function askRouteMenu(chatId, orig, images, mediaGroupId) {
  const m = { id: newUnitDraftId(), orig: orig, images: images, mediaGroupId: mediaGroupId || null, used: null };
  saveUnitMenu(m);
  if (mediaGroupId) unitCache().put('unitgroup_' + mediaGroupId, 'menu:' + m.id, UNIT_CACHE_SECONDS);
  unitSessionTouch();
  const f = parseUnitFacts(orig.text);
  const bits = [];
  if (f.buildingName) bits.push(f.buildingName);
  if (f.bedrooms !== null) bits.push(f.bedrooms === 0 ? 'studio' : f.bedrooms + ' bedroom');
  if (f.price !== null) bits.push(formatUsd(f.price));
  const rows = [[
    { text: 'Website draft', callback_data: 'menu_' + m.id + '_site' },
    { text: 'Post to channels', callback_data: 'menu_' + m.id + '_chan' },
  ], [
    { text: 'Both', callback_data: 'menu_' + m.id + '_both' },
    { text: 'Ignore', callback_data: 'menu_' + m.id + '_ign' },
  ]];
  sendTelegramMessage(chatId,
    'What should I do with this post?' + (bits.length ? '\n' + bits.join(', ') : '') + (images.length ? '\n' + images.length + ' photo' + (images.length === 1 ? '' : 's') : ''),
    { inline_keyboard: rows });
}

function handleMenuCallback(cb, rest) {
  const chatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
  if (chatId !== REVIEWER_CHAT_ID) { answerCallback(cb.id, 'Not allowed.'); return; }
  const parts = String(rest).split('_');
  const id = parts[0], verb = parts[1];
  const m = loadUnitMenu(id);
  const messageId = cb.message.message_id;
  if (!m) { answerCallback(cb.id, 'This question expired. Send the post again.'); return; }
  if (m.used) { answerCallback(cb.id, 'Already handled.'); return; }
  unitSessionTouch();
  if (verb === 'ign') {
    m.used = 'ign'; saveUnitMenu(m);
    answerCallback(cb.id, 'Ignored.');
    editUnitMessage(chatId, messageId, 'Ignored. Nothing was done.', null);
    return;
  }
  if (verb === 'chan') {
    m.used = 'chan'; saveUnitMenu(m);
    answerCallback(cb.id, 'Preparing the channel posts...');
    editUnitMessage(chatId, messageId, 'Posting to channels: preparing the EN, JP, RU and DE versions for your approval.', null);
    processChannelListing(chatId, m.orig.text, m.orig.photoIds, m.orig.isForwarded, m.orig.sourceUsername, m.orig.entities);
    return;
  }
  if (verb === 'site' || verb === 'both') {
    m.used = verb; saveUnitMenu(m);
    answerCallback(cb.id, verb === 'both' ? 'Website draft first, channels after.' : 'Starting the website draft.');
    editUnitMessage(chatId, messageId, verb === 'both' ? 'Both: starting the website draft. The channel posts come after the page is live.' : 'Starting the website draft.', null);
    startWebsiteDraft(chatId, m.orig.text, m.images, m.mediaGroupId, m.orig, verb);
    return;
  }
  answerCallback(cb.id, '');
}

// ── Step 1: start a website draft from a post ───────────────────────

function startWebsiteDraft(chatId, text, imageFileIds, mediaGroupId, orig, route) {
  chatId = String(chatId); // Telegram only accepts the chat id as text from Apps Script (a Number goes out as "3.5E8" and fails with "chat not found")
  const facts = parseUnitFacts(text);
  const images = (imageFileIds || []).slice(0, UNIT_MAX_PHOTOS);
  const problems = [];
  if (facts.price === null) problems.push('a price, like $185,000');
  if (facts.usedSqft) problems.push('the size in sqm (we use sqm only, I do not convert feet)');
  if (problems.length) {
    sendTelegramMessage(chatId,
      'I need this before I can start a draft:\n- ' + problems.join('\n- ') +
      '\n\nExample: #unit 2 bedroom, floor 14, 85 sqm, $185,000\nSend the post again with that fixed.');
    return;
  }
  const d = {
    id: newUnitDraftId(), step: 'building', route: route || 'site', facts: facts, images: images, orig: orig || null,
    parentId: null, buildingName: facts.buildingName || null, title: null, features: [], extraFeatures: facts.extraFeatures || [],
    propertyType: facts.propertyType || null, typeAssumed: false, location: facts.locationText || null, city: facts.city || null,
    messageId: null, created: null,
  };
  if (!d.buildingName) {
    const found = findProjectInText(text, fetchUnitProjects());
    if (found) { d.parentId = found.id; d.buildingName = found.title; d.location = null; d.city = null; d.matchedFromText = true; }
  }
  if (d.buildingName && !d.parentId) {
    const hit = matchUnitProject(d.buildingName, fetchUnitProjects());
    if (hit) { d.parentId = hit.id; d.buildingName = hit.title; d.location = null; d.city = null; }
  }
  saveUnitDraft(d);
  if (mediaGroupId) unitCache().put('unitgroup_' + mediaGroupId, 'draft:' + d.id, UNIT_CACHE_SECONDS); // so a late photo of this album can still join
  unitSessionTouch();
  advanceUnitDraft(chatId, d, null);
}

// Works out the next missing piece and asks for it; when nothing is missing, shows the summary.
function advanceUnitDraft(chatId, d, messageId) {
  if (!d.buildingName) { d.step = 'building'; saveUnitDraft(d); return askUnitBuilding(chatId, d, messageId); }
  if (!d.parentId && !d.location) { d.step = 'area'; saveUnitDraft(d); return askUnitArea(chatId, d, messageId); }
  const noRooms = d.propertyType === 'Land' || d.propertyType === 'Commercial';
  if (d.facts.bedrooms === null && !d.bedroomsAsked && !noRooms) { d.step = 'bedrooms'; d.bedroomsAsked = true; saveUnitDraft(d); return askUnitBedrooms(chatId, d, messageId); }
  if (!d.propertyType) {
    const f = d.facts;
    if ((f.floor || f.unitNumber) && f.bedrooms !== null) { d.propertyType = 'Condo'; d.typeAssumed = true; }
    else { d.step = 'type'; saveUnitDraft(d); return askUnitType(chatId, d, messageId); }
  }
  d.step = 'summary';
  saveUnitDraft(d);
  return showUnitSummary(chatId, d, messageId);
}

// Say something: edit the message that was tapped, or send a new one.
function unitSay(chatId, messageId, text, markup) {
  if (messageId) editUnitMessage(chatId, messageId, text, markup);
  else sendTelegramMessage(chatId, text, markup);
}

function askUnitBuilding(chatId, d, messageId) {
  const f = d.facts;
  unitSay(chatId, messageId,
    'Got ' + d.images.length + ' photo' + (d.images.length === 1 ? '' : 's') + (f.video ? ' and a video link' : '') + '. Is this building already on the website?',
    { inline_keyboard: [[
      { text: 'Select existing project', callback_data: 'unit_' + d.id + '_pick' },
      { text: 'New building', callback_data: 'unit_' + d.id + '_new' },
    ], [{ text: 'Cancel', callback_data: 'unit_' + d.id + '_x' }]] });
}

function askUnitArea(chatId, d, messageId) {
  const rows = [];
  for (let i = 0; i < UNIT_AREAS.length; i += 2) {
    rows.push(UNIT_AREAS.slice(i, i + 2).map(function (a, k) { return { text: a, callback_data: 'unit_' + d.id + '_a_' + (i + k) }; }));
  }
  rows.push([{ text: 'Cancel', callback_data: 'unit_' + d.id + '_x' }]);
  unitSay(chatId, messageId, d.buildingName + ' is not on the website yet. Which area is it in?', { inline_keyboard: rows });
}

function askUnitBedrooms(chatId, d, messageId) {
  const labels = ['Studio', '1 bedroom', '2 bedrooms', '3 bedrooms', '4 bedrooms', '5 or more'];
  const rows = [];
  for (let i = 0; i < labels.length; i += 3) {
    rows.push(labels.slice(i, i + 3).map(function (l, k) { return { text: l, callback_data: 'unit_' + d.id + '_b_' + (i + k) }; }));
  }
  rows.push([{ text: 'Skip, not sure', callback_data: 'unit_' + d.id + '_b_s' }, { text: 'Cancel', callback_data: 'unit_' + d.id + '_x' }]);
  unitSay(chatId, messageId, 'Your post does not say the bedrooms. How many bedrooms?', { inline_keyboard: rows });
}

function askUnitType(chatId, d, messageId) {
  const rows = [];
  for (let i = 0; i < UNIT_TYPES.length; i += 2) {
    rows.push(UNIT_TYPES.slice(i, i + 2).map(function (t, k) { return { text: t, callback_data: 'unit_' + d.id + '_t_' + (i + k) }; }));
  }
  rows.push([{ text: 'Cancel', callback_data: 'unit_' + d.id + '_x' }]);
  unitSay(chatId, messageId, 'What type of property is it?', { inline_keyboard: rows });
}

// A typed reply to "What is the building called?" / "Which area?"
function isAwaitingUnitText(chatId, text, isForwarded) {
  if (!text || isForwarded) return false;
  if (/#ForSale|#ForRent|#NewProject/i.test(text)) return false;
  return !!unitCache().get('unitawait_' + chatId);
}

function handleUnitTextReply(chatId, text) {
  chatId = String(chatId);
  const raw = unitCache().get('unitawait_' + chatId);
  unitCache().remove('unitawait_' + chatId);
  let wait = null;
  try { wait = JSON.parse(raw); } catch (e) { wait = null; }
  const d = wait && wait.id ? loadUnitDraft(wait.id) : null;
  const value = String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!d || !value) { sendTelegramMessage(chatId, 'That draft has expired. Send the post again.'); return; }
  if (wait.what === 'area') {
    d.location = value;
    d.city = d.city || 'Phnom Penh';
  } else {
    const hit = matchUnitProject(value, fetchUnitProjects());
    if (hit) { d.parentId = hit.id; d.buildingName = hit.title; d.location = null; d.city = null; }
    else { d.buildingName = titleCaseBuilding(value); d.parentId = null; }
  }
  unitSessionTouch();
  advanceUnitDraft(chatId, d, null);
}

// ── Buttons of the draft ────────────────────────────────────────────

function handleUnitCallback(cb, rest) {
  const chatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
  if (chatId !== REVIEWER_CHAT_ID) { answerCallback(cb.id, 'Not allowed.'); return; }
  const parts = String(rest).split('_');
  const id = parts[0], verb = parts[1], arg = parts[2];
  const d = loadUnitDraft(id);
  if (!d) { answerCallback(cb.id, 'This draft expired. Send the post again.'); return; }
  const messageId = cb.message.message_id;
  unitSessionTouch();

  if (verb === 'x') {
    unitCache().remove('unitdraft_' + id);
    unitSessionEnd();
    answerCallback(cb.id, 'Cancelled.');
    editUnitMessage(chatId, messageId, 'Cancelled. Nothing was created.', null);
    return;
  }
  if (verb === 'chan') { handleUnitChannelTap(cb, chatId, messageId, d); return; }
  if (d.step === 'running' || d.step === 'done') { answerCallback(cb.id, d.step === 'done' ? 'Already created.' : 'Already working on it.'); return; }

  if (verb === 'pick' || verb === 'back') {
    answerCallback(cb.id, '');
    const projects = fetchUnitProjects();
    if (!projects.length) { editUnitMessage(chatId, messageId, 'I could not load the project list. Tap New building, or try again in a minute.', null); return; }
    const rows = [];
    for (let i = 0; i < projects.length; i += 2) {
      rows.push(projects.slice(i, i + 2).map(function (p) { return { text: p.title, callback_data: 'unit_' + id + '_p_' + p.id }; }));
    }
    rows.push([{ text: 'New building instead', callback_data: 'unit_' + id + '_new' }, { text: 'Cancel', callback_data: 'unit_' + id + '_x' }]);
    editUnitMessage(chatId, messageId, 'Which project is this unit in?', { inline_keyboard: rows });
    return;
  }
  if (verb === 'new') {
    answerCallback(cb.id, '');
    unitCache().put('unitawait_' + chatId, JSON.stringify({ id: id, what: 'name' }), 3600);
    editUnitMessage(chatId, messageId, 'What is the building called? Reply with just the name, for example: Sky Villa', null);
    return;
  }
  if (verb === 'p') {
    const pid = parseInt(arg, 10);
    const proj = fetchUnitProjects().filter(function (p) { return p.id === pid; })[0];
    if (!proj) { answerCallback(cb.id, 'Project not found.'); return; }
    d.parentId = proj.id; d.buildingName = proj.title; d.location = null; d.city = null;
    answerCallback(cb.id, proj.title);
    saveUnitDraft(d);
    advanceUnitDraft(chatId, d, messageId);
    return;
  }
  if (verb === 'a') {
    const area = UNIT_AREAS[parseInt(arg, 10)];
    if (!area) { answerCallback(cb.id, ''); return; }
    answerCallback(cb.id, area);
    if (area === 'Other') {
      unitCache().put('unitawait_' + chatId, JSON.stringify({ id: id, what: 'area' }), 3600);
      editUnitMessage(chatId, messageId, 'Which area is it in? Reply with just the area name.', null);
      return;
    }
    d.location = area; d.city = d.city || 'Phnom Penh';
    saveUnitDraft(d);
    advanceUnitDraft(chatId, d, messageId);
    return;
  }
  if (verb === 'b') {
    if (arg !== 's') {
      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 0 || n > 5) { answerCallback(cb.id, ''); return; }
      d.facts.bedrooms = n;
      answerCallback(cb.id, n === 0 ? 'Studio' : n + (n === 1 ? ' bedroom' : ' bedrooms'));
    } else {
      answerCallback(cb.id, 'Skipped.');
    }
    d.title = null; // the title depends on the bedrooms
    saveUnitDraft(d);
    advanceUnitDraft(chatId, d, messageId);
    return;
  }
  if (verb === 't') {
    const type = UNIT_TYPES[parseInt(arg, 10)];
    if (!type) { answerCallback(cb.id, ''); return; }
    d.propertyType = type; d.typeAssumed = false;
    answerCallback(cb.id, type);
    saveUnitDraft(d);
    advanceUnitDraft(chatId, d, messageId);
    return;
  }
  if (verb === 'chg') {
    answerCallback(cb.id, '');
    d.propertyType = null; d.typeAssumed = false; d.step = 'type';
    saveUnitDraft(d);
    askUnitType(chatId, d, messageId);
    return;
  }
  if (verb === 'f') {
    const f = UNIT_FACILITIES[parseInt(arg, 10)];
    if (!f) { answerCallback(cb.id, ''); return; }
    const at = d.features.indexOf(f);
    if (at === -1) d.features.push(f); else d.features.splice(at, 1);
    saveUnitDraft(d);
    answerCallback(cb.id, '');
    showUnitSummary(chatId, d, messageId, true);
    return;
  }
  if (verb === 'go' && !d.dupOk) {
    const twins = findUnitTwins(d);
    if (twins.length) {
      answerCallback(cb.id, 'Possible duplicate.');
      editUnitMessage(chatId, messageId, duplicateWarningText(twins), { inline_keyboard: [
        [{ text: 'Create another anyway', callback_data: 'unit_' + d.id + '_dup' }],
        [{ text: 'Cancel', callback_data: 'unit_' + d.id + '_x' }],
      ] });
      return;
    }
  }
  if (verb === 'go' || verb === 'dup') {
    if (verb === 'dup') { d.dupOk = true; saveUnitDraft(d); }
    answerCallback(cb.id, 'Working on it...');
    runUnitCreate(chatId, id, messageId);
    return;
  }
  answerCallback(cb.id, '');
}

// Units of the same building that look like this one (same floor and bedrooms, or the same private unit number).
// If the website cannot be asked, the draft goes ahead: a failed check must never block your work.
function findUnitTwins(d) {
  if (!d.parentId) return [];
  const f = d.facts;
  if (!f.floor && !f.unitNumber) return [];
  const r = callIntake({ action: 'twins', parentPropertyId: d.parentId, listingType: f.listingType || 'resale', floor: f.floor, bedrooms: f.bedrooms, unitNumber: f.unitNumber });
  if (r.code !== 200 || !r.body || !r.body.ok || !r.body.twins) return [];
  return r.body.twins;
}

function duplicateWarningText(twins) {
  const label = function (st) { return st === 'active' ? 'live' : (st === 'draft' ? 'hidden draft' : st); };
  return 'Possible duplicate. The website already has ' + (twins.length === 1 ? 'a unit' : twins.length + ' units') + ' like this one in the same building:\n\n' +
    twins.map(function (t) { return t.refCode + ': ' + t.title + ', ' + formatUsd(t.price) + ' (' + label(t.status) + ')'; }).join('\n') +
    (twins.every(function (t) { return t.status === 'sold' || t.status === 'rented' || t.status === 'inactive'; })
      ? '\n\nThe existing one is no longer live, so this may be the same unit listed again. Create another if it is.'
      : '\n\nIf it is the same unit, cancel and change the price of the existing one instead (send "' + twins[0].refCode + ' price reduced to $..."). Otherwise create another.');
}

// Returns true if these photos belong to an album whose text was already handled.
function unitAddLateAlbumPhotos(chatId, mediaGroupId, imageIds, photoIds) {
  const ref = unitCache().get('unitgroup_' + mediaGroupId);
  if (!ref) return false;
  chatId = String(chatId);
  const kind = ref.indexOf(':') !== -1 ? ref.split(':')[0] : 'draft';
  const id = ref.indexOf(':') !== -1 ? ref.split(':')[1] : ref;
  const addTo = function (list, items) { (items || []).forEach(function (f) { if (list.indexOf(f) === -1 && list.length < UNIT_MAX_PHOTOS) list.push(f); }); };
  if (kind === 'menu') {
    const m = loadUnitMenu(id);
    if (!m) return true;
    if (m.used === 'chan' || m.used === 'ign') {
      if (m.used === 'chan') sendTelegramMessage(chatId, 'One more photo from that album arrived after I had started the channel posts, so it is not included.');
      return true;
    }
    addTo(m.images, imageIds); addTo(m.orig.photoIds, photoIds);
    saveUnitMenu(m);
    return true;
  }
  const d = loadUnitDraft(id);
  if (!d) return true; // the draft was cancelled or expired: drop the stray photos quietly
  if (d.step === 'running' || d.step === 'done') {
    sendTelegramMessage(chatId, 'One more photo from that album arrived after I had started creating the page, so it is not included. Add it later in the admin if you need it.');
    return true;
  }
  addTo(d.images, imageIds);
  if (d.orig) addTo(d.orig.photoIds, photoIds);
  saveUnitDraft(d);
  return true;
}

// ── Step 3: the summary ─────────────────────────────────────────────

function unitFinalFeatures(d) {
  const out = [];
  (d.extraFeatures || []).concat(d.features || []).forEach(function (x) {
    const low = String(x).toLowerCase();
    if (!out.some(function (y) { return y.toLowerCase() === low; })) out.push(x);
  });
  return out.slice(0, 30);
}

function unitSummaryText(d) {
  const f = d.facts;
  const type = d.propertyType ? d.propertyType + (d.typeAssumed ? ' (assumed, tap Change type to fix)' : '') : 'not set';
  const missing = [];
  if (f.bedrooms === null && d.propertyType !== 'Land') missing.push('bedrooms');
  if (f.bathrooms === null && d.propertyType !== 'Land') missing.push('bathrooms');
  if (!f.sqm) missing.push('size');
  if (!f.floor && d.propertyType !== 'Land' && d.propertyType !== 'Villa / House') missing.push('floor');
  if (!d.images.length) missing.push('photos');
  const feats = unitFinalFeatures(d);
  const lines = [
    'Unit summary',
    '',
    'Building: ' + d.buildingName + (d.parentId ? ' (on the website' + (d.matchedFromText ? ', found in your post' : '') + ')' : ' (new building' + (d.location ? ', ' + d.location : '') + ')'),
    'Page title: ' + (d.title || '...'),
    'Type: ' + type,
    'Listing: ' + (f.listingType === 'rent' ? 'For rent' : 'Resale') + '   Price: ' + formatUsd(f.price) + (f.listingType === 'rent' ? '/month' : ''),
    'Bedrooms: ' + (f.bedrooms === null ? 'not given' : (f.bedrooms === 0 ? 'Studio' : f.bedrooms)) + '   Bathrooms: ' + (f.bathrooms === null ? 'not given' : f.bathrooms) + '   Area: ' + (f.sqm ? f.sqm + ' sqm' : 'not given'),
    'Floor: ' + (f.floor || 'not given') + (f.unitNumber ? '   Unit no. (private, never shown): ' + f.unitNumber : ''),
    'Photos: ' + d.images.length + '   Video: ' + (f.video ? 'yes' : 'no'),
  ];
  if ((d.extraFeatures || []).length) lines.push('From your post: ' + d.extraFeatures.slice(0, 8).join(', ') + (d.extraFeatures.length > 8 ? ' and ' + (d.extraFeatures.length - 8) + ' more' : ''));
  if (f.paymentFound) lines.push('Payment plan found in your post: not added to the page (add it in the admin if you want it)');
  if (missing.length) lines.push('Not given: ' + missing.join(', ') + ' (you will see these on the draft page checklist)');
  const claim = feats.filter(function (x) { return /strata|hard title|soft title|freehold|guarantee|yield|roi|return/i.test(x); });
  if (claim.length) lines.push('Claim to verify before going live: ' + claim.join(', '));
  lines.push('');
  lines.push('Facilities: ' + (d.features.length ? d.features.length + ' ticked' : (d.parentId ? 'none ticked. The building\'s own facilities show automatically; tick any extra this unit has' : 'tick the facilities this unit has')));
  return lines.join('\n');
}

function unitSummaryKeyboard(d) {
  const rows = [];
  for (let i = 0; i < UNIT_FACILITIES.length; i += 2) {
    rows.push([i, i + 1].filter(function (k) { return k < UNIT_FACILITIES.length; }).map(function (k) {
      const on = d.features.indexOf(UNIT_FACILITIES[k]) !== -1;
      return { text: (on ? '✅ ' : '⬜ ') + UNIT_FACILITIES[k], callback_data: 'unit_' + d.id + '_f_' + k };
    }));
  }
  rows.push([{ text: 'Create draft page', callback_data: 'unit_' + d.id + '_go' }]);
  rows.push([{ text: 'Change type', callback_data: 'unit_' + d.id + '_chg' }, { text: 'Change building', callback_data: 'unit_' + d.id + '_back' }]);
  rows.push([{ text: 'Cancel', callback_data: 'unit_' + d.id + '_x' }]);
  return { inline_keyboard: rows };
}

// `keepTitle` is true on facility taps: the title was already worked out, no need to ask the website again.
function showUnitSummary(chatId, d, messageId, keepTitle) {
  chatId = String(chatId);
  if (!keepTitle || !d.title) {
    const res = callIntake({
      action: 'prepare', parentPropertyId: d.parentId, buildingName: d.buildingName,
      bedrooms: d.facts.bedrooms, floor: d.facts.floor,
    });
    if (res.code !== 200 || !res.body.ok) {
      unitSay(chatId, messageId, describeIntakeFailure(res, 'prepare the page title'), null);
      return;
    }
    d.title = res.body.title;
    saveUnitDraft(d);
  }
  const text = (isUnitDryRun() ? '[DRY RUN, nothing will be created]\n\n' : '') + unitSummaryText(d);
  const kb = unitSummaryKeyboard(d);
  if (messageId) editUnitMessage(chatId, messageId, text, kb);
  else { const sent = sendTelegramMessage(chatId, text, kb); if (sent) { d.messageId = sent.message_id; saveUnitDraft(d); } }
}

// ── Step 4: upload the photos in small requests, then create the draft ──

function runUnitCreate(chatId, id, messageId) {
  chatId = String(chatId);
  // Telegram can deliver the same tap twice if a run overlaps the next 1-minute poll,
  // so only the first one may start.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let d;
  try {
    d = loadUnitDraft(id);
    if (!d || d.step === 'running' || d.step === 'done') return;
    d.step = 'running';
    saveUnitDraft(d);
  } finally { lock.releaseLock(); }

  const back = function (text) { d.step = 'summary'; saveUnitDraft(d); sendTelegramMessage(chatId, text); };
  editUnitMessage(chatId, messageId, (isUnitDryRun() ? '[DRY RUN] ' : '') + 'Creating the draft for ' + d.title + '. This takes about a minute, I will message you when it is ready.', null);

  // Decide the final title/folder first, so a unit can never share a photo folder with another.
  const f = d.facts;
  const prep = callIntake({ action: 'prepare', parentPropertyId: d.parentId, buildingName: d.buildingName, bedrooms: f.bedrooms, floor: f.floor });
  if (prep.code !== 200 || !prep.body.ok) { back(describeIntakeFailure(prep, 'prepare the page title') + '\nTap Create draft page to try again.'); return; }
  const title = prep.body.title, slug = prep.body.slug;

  // The photo batches go to the website side by side (a few at a time), not one after the other.
  const batches = [];
  for (let i = 0; i < d.images.length; i += UNIT_PHOTOS_PER_REQUEST) {
    batches.push({ action: 'photos', slug: slug, startIndex: i, fileIds: d.images.slice(i, i + UNIT_PHOTOS_PER_REQUEST) });
  }
  const urls = [];
  for (let g = 0; g < batches.length; g += UNIT_PARALLEL_BATCHES) {
    const results = callIntakeMany(batches.slice(g, g + UNIT_PARALLEL_BATCHES));
    for (let k = 0; k < results.length; k++) {
      const res = results[k];
      if (res.code !== 200 || !res.body.ok) {
        callIntake({ action: 'cleanup', slug: slug }); // remove what was already uploaded
        back(describeIntakeFailure(res, 'store the photos') + '\nNothing was created. Tap Create draft page to try again.');
        return;
      }
      res.body.urls.forEach(function (u) { urls.push(u); });
    }
  }

  const isLand = d.propertyType === 'Land';
  // A unit in a building on the site shows that building's facilities, video and completion date LIVE on its page, so only
  // this unit's own features are stored here (what the post says, plus anything you ticked).
  const created = callIntake({
    action: 'create', title: title, folder: slug, price: f.price, listingType: f.listingType || 'resale',
    parentPropertyId: d.parentId, unitNumber: f.unitNumber, unitFloor: f.floor,
    bedrooms: isLand ? null : f.bedrooms, bathrooms: isLand ? null : f.bathrooms,
    sqm: f.sqm || 0, floorArea: f.sqm ? f.sqm + ' sqm' : null,
    propertyType: d.propertyType, location: d.location, city: d.city,
    features: unitFinalFeatures(d), images: urls, videoUrl: f.video,
  });
  if (created.code !== 200 || !created.body.ok) {
    callIntake({ action: 'cleanup', slug: slug });
    back(describeIntakeFailure(created, 'create the draft') + '\nNothing was created. Tap Create draft page to try again.');
    return;
  }

  d.step = 'done';
  d.created = { id: created.body.id, slug: created.body.slug || slug, refCode: created.body.refCode || null, title: title };
  saveUnitDraft(d);
  unitSessionEnd();
  const both = d.route === 'both';
  sendTelegramMessage(chatId,
    (isUnitDryRun() ? '[DRY RUN] ' : '') + 'Hidden draft created. Nobody else can see it yet.\n\n' +
    title + (created.body.refCode ? '\nRef: ' + created.body.refCode : '') + '\n\nPreview link:\n' + created.body.previewUrl + '\n\n' +
    '1. Open the link while you are logged in to the website as admin.\n' +
    '2. Check the photos, facts and the checklist of open items.\n' +
    '3. Tap Publish Unit Live, then Confirm.' +
    (both ? '\n\nWhen the page is live, tap the button below and I will prepare the channel posts with its link.' : ''),
    both ? { inline_keyboard: [[{ text: 'The page is live, prepare channel posts', callback_data: 'unit_' + d.id + '_chan' }]] } : null);
}

// ── "Both": the channel posts come after the page is live ───────────

function unitPageIsLive(id) {
  const resp = UrlFetchApp.fetch(SUPABASE_REST_URL + '/properties?select=id&id=eq.' + id + '&status=eq.active', {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + SUPABASE_PUBLISHABLE_KEY },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) return false;
  try { return JSON.parse(resp.getContentText()).length > 0; } catch (e) { return false; }
}

// The channel posts are built from the same facts, in the template the existing flow already reads.
function unitFactsToChannelText(d) {
  const f = d.facts;
  const price = formatUsd(f.price);
  const lines = [f.listingType === 'rent' ? '#ForRent ' + price + '/month' : '#ForSale ' + price, ''];
  const kind = f.bedrooms === 0 ? 'STUDIO' : (f.bedrooms ? f.bedrooms + 'BR UNIT' : 'UNIT');
  lines.push(String(d.buildingName).toUpperCase() + ' | ' + kind);
  const loc = [d.location, d.city].filter(Boolean).join(', ');
  if (loc) lines.push('📍 ' + loc);
  lines.push('', '――――――――――', '', 'UNIT DETAILS');
  if (f.bedrooms !== null || f.bathrooms !== null) lines.push(formatBedBath({ beds: f.bedrooms, baths: f.bathrooms }, 'EN'));
  if (f.floor) lines.push('✅ ' + f.floor + (/^\d+$/.test(f.floor) ? 'th' : '') + ' Floor');
  if (f.sqm) lines.push('✅ ' + f.sqm + ' sqm');
  unitFinalFeatures(d).forEach(function (x) { lines.push('✅ ' + x); });
  return lines.join('\n');
}

function handleUnitChannelTap(cb, chatId, messageId, d) {
  if (!d.created) { answerCallback(cb.id, 'The page is not created yet.'); return; }
  if (d.channelsStarted) { answerCallback(cb.id, 'Already started.'); return; }
  if (!isUnitDryRun() && !unitPageIsLive(d.created.id)) {
    answerCallback(cb.id, 'Not live yet.');
    sendTelegramMessage(chatId, 'The page is not live yet. Open the preview link, tap Publish Unit Live and Confirm on the website, then tap the button again.');
    return;
  }
  d.channelsStarted = true;
  saveUnitDraft(d);
  answerCallback(cb.id, 'Preparing the channel posts...');
  const pageUrl = 'https://www.propertyhubcambodia.com/property/' + d.created.slug;
  const original = d.orig && /#ForSale|#ForRent|#NewProject/i.test(d.orig.text || '') ? d.orig.text : unitFactsToChannelText(d);
  const photoIds = d.orig && d.orig.photoIds && d.orig.photoIds.length ? d.orig.photoIds : [];
  processChannelListing(chatId, original, photoIds, false, null, null, pageUrl, d.created.refCode);
}

// ── Price update: change the price of a unit that is already on the website ─────────
// Nick sends e.g. "TS10-1021 price reduced to $58,500". The bot finds the unit by its number, shows old and new, and
// changes the price only after a tap. The website keeps the old price in its history.

const PRICE_BIG_CHANGE = 0.15; // a change bigger than this must be confirmed a second time (a typo guard)

function priceCache(id) { return 'unitprice_' + id; }
function loadPriceState(id) { const raw = unitCache().get(priceCache(id)); return raw ? JSON.parse(raw) : null; }
function savePriceState(st) { unitCache().put(priceCache(st.unitId), JSON.stringify(st), UNIT_CACHE_SECONDS); }

function parseMoneyAmount(num, suffix) {
  let v = parseFloat(String(num).replace(/,/g, ''));
  if (isNaN(v)) return null;
  const sx = String(suffix || '').toLowerCase();
  if (sx === 'k') v *= 1000;
  if (sx === 'm') v *= 1000000;
  return Math.round(v);
}

// Returns {id, ref, newPrice} when the text is a price change for a numbered unit, otherwise null.
function parsePriceUpdate(text) {
  const t = String(text || '');
  const tagged = /(^|\s)[#\/]price\b/i.test(t);
  const wording = /\bprice\s*(drop|dropped|reduc\w*|cut|change\w*|update\w*|down|lowered)\b|\breduced\b|\bnew\s+price\b|\bprice\s+now\b|\bnow\s+\$|\blowered\b|\bdropped\s+to\b/i.test(t);
  if (!tagged && !wording) return null;
  const refMatch = t.match(/\b([A-Za-z][A-Za-z0-9]{0,5})-(\d{4,6})\b/) || (tagged ? t.match(/(?:^|\s)(\d{4,6})\b/) : null);
  if (!refMatch) return null;
  const digits = parseInt(refMatch[refMatch.length - 1], 10);
  if (!(digits > 1000)) return null;
  const rest = t.replace(refMatch[0], ' ');
  const amounts = [];
  const re = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?(?![a-z0-9])/gi;
  let m;
  while ((m = re.exec(rest))) {
    const before = rest.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
    amounts.push({ value: parseMoneyAmount(m[1], m[2]), old: /(was|from|before|old|instead of)\W*$/.test(before), after: /(to|now|new price|price)\W*$/.test(before) });
  }
  let chosen = amounts.filter(function (a) { return !a.old; });
  if (chosen.length > 1) { const pointed = chosen.filter(function (a) { return a.after; }); if (pointed.length) chosen = pointed; }
  let newPrice = chosen.length ? chosen[chosen.length - 1].value : null;
  if (newPrice === null && tagged) {
    const bare = rest.match(/(?:^|\s)(\d[\d,]{2,})\s*([km])?(?![a-z0-9])/i);
    if (bare) newPrice = parseMoneyAmount(bare[1], bare[2]);
  }
  return { id: digits - 1000, ref: refMatch[0], newPrice: newPrice };
}

function startPriceUpdate(chatId, pu) {
  chatId = String(chatId);
  if (!pu.newPrice) {
    const label = pu.ref || ('number ' + (pu.id + 1000));
    sendTelegramMessage(chatId, 'I found ' + label + ' but not the new price.\nExample: ' + (pu.ref || 'TS10-' + (pu.id + 1000)) + ' price reduced to $58,500');
    return;
  }
  const r = callIntake({ action: 'lookup', id: pu.id });
  if (r.code === 404) {
    sendTelegramMessage(chatId, 'I could not find a single unit with the number ' + (pu.ref || (pu.id + 1000)) + '. Project pages are never changed this way.');
    return;
  }
  if (r.code !== 200 || !r.body || !r.body.ok) {
    sendTelegramMessage(chatId, 'The website did not answer (' + r.code + '). Nothing was changed. Try again in a minute.');
    return;
  }
  const u = r.body;
  const suffix = u.listingType === 'rent' ? '/month' : '';
  if (u.price === pu.newPrice) {
    sendTelegramMessage(chatId, u.refCode + ' is already ' + formatUsd(u.price) + suffix + ' on the website. Nothing to change.');
    return;
  }
  const change = (pu.newPrice - u.price) / u.price;
  const pct = Math.abs(change * 100).toFixed(1).replace(/\.0$/, '');
  const st = {
    unitId: u.id, ref: u.refCode, title: u.title, oldPrice: u.price, newPrice: pu.newPrice, status: u.status, listingType: u.listingType,
    url: u.url, bedrooms: u.bedrooms, bathrooms: u.bathrooms, sqm: u.sqm, floor: u.floor, location: u.location, city: u.city,
    big: Math.abs(change) > PRICE_BIG_CHANGE, confirmed: false, used: null,
  };
  savePriceState(st);
  unitSessionTouch();
  const live = u.status === 'active';
  let text = 'Found ' + u.refCode + ': ' + u.title + '\n' + formatUsd(u.price) + suffix + ' to ' + formatUsd(pu.newPrice) + suffix + ' (' + (change < 0 ? 'down ' : 'up ') + pct + '%)\n' +
    (live ? 'Live on the website now.' : 'This page is not live yet (' + (u.status === 'draft' ? 'hidden draft' : u.status) + '). Only the price is saved.');
  if (st.big) text += '\n\nThis is a change of more than 15%. Please check the new price is not a typo. I will ask you to confirm once more.';
  sendTelegramMessage(chatId, text, priceKeyboard(st));
}

function priceKeyboard(st) {
  const rows = [[{ text: 'Update website price', callback_data: 'price_' + st.unitId + '_go' }]];
  if (st.status === 'active') rows[0].push({ text: 'Update and post', callback_data: 'price_' + st.unitId + '_post' });
  rows.push([{ text: 'Cancel', callback_data: 'price_' + st.unitId + '_no' }]);
  return { inline_keyboard: rows };
}

function handlePriceCallback(cb, rest) {
  const chatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
  if (chatId !== REVIEWER_CHAT_ID) { answerCallback(cb.id, 'Not allowed.'); return; }
  const parts = String(rest).split('_');
  const st = loadPriceState(parts[0]);
  const verb = parts[1];
  const messageId = cb.message.message_id;
  if (!st) { answerCallback(cb.id, 'This question expired. Send the price again.'); return; }
  if (st.used) { answerCallback(cb.id, 'Already handled.'); return; }
  unitSessionTouch();
  if (verb === 'no') {
    st.used = 'no'; savePriceState(st);
    answerCallback(cb.id, 'Cancelled.');
    editUnitMessage(chatId, messageId, 'Cancelled. The price was not changed.', null);
    return;
  }
  if (verb !== 'go' && verb !== 'post') { answerCallback(cb.id, ''); return; }
  if (st.big && !st.confirmed) {
    st.confirmed = true; savePriceState(st);
    answerCallback(cb.id, 'Please confirm.');
    editUnitMessage(chatId, messageId,
      'Please confirm: ' + st.ref + ' from ' + formatUsd(st.oldPrice) + ' to ' + formatUsd(st.newPrice) + '. That is a big change. Tap again to apply it.', priceKeyboard(st));
    return;
  }
  st.used = verb; savePriceState(st);
  const r = callIntake({ action: 'price', id: st.unitId, expectedOldPrice: st.oldPrice, newPrice: st.newPrice });
  if (r.code === 409) {
    st.used = null; savePriceState(st);
    answerCallback(cb.id, 'The price changed meanwhile.');
    const now = r.body && r.body.currentPrice ? ' It is now ' + formatUsd(r.body.currentPrice) + '.' : '';
    editUnitMessage(chatId, messageId, 'Nothing was changed. The price on the website was changed by someone else.' + now + ' Send the new price again.', null);
    return;
  }
  if (r.code !== 200 || !r.body || !r.body.ok) {
    st.used = null; savePriceState(st);
    answerCallback(cb.id, 'Failed.');
    editUnitMessage(chatId, messageId, 'The website did not accept the change (' + r.code + '). Nothing was changed. Tap again to retry.', priceKeyboard(st));
    return;
  }
  answerCallback(cb.id, 'Price updated.');
  const suffix = st.listingType === 'rent' ? '/month' : '';
  editUnitMessage(chatId, messageId, 'Done. ' + st.ref + ' is now ' + formatUsd(st.newPrice) + suffix + ' on the website (was ' + formatUsd(st.oldPrice) + suffix + '). The old price is kept in the history.', null);
  if (verb === 'post') {
    if (st.status !== 'active') { sendTelegramMessage(chatId, 'The page is not live, so I did not prepare channel posts.'); return; }
    processChannelListing(chatId, priceDropChannelText(st), [], false, null, null, st.url, st.ref);
  }
}

// ── Replying to the bot's own website messages ───────────────────────────────────────
// "Hidden draft created ... Ref: TS10-1021" or "Found TS10-1021 ..." can be answered directly: "SOLD", "RENTED",
// "reduced to $48,999" or just "$48,999". The unit number is read from the message being replied to.

function replyIsChannelReview(messageId) {
  try {
    const sheet = getQueueSheet();
    const rows = sheet.getDataRange().getValues();
    const reviewIdx = rows[0].indexOf('reviewMsgId');
    for (let i = 1; i < rows.length; i++) if (String(rows[i][reviewIdx]) === String(messageId)) return true;
  } catch (e) { /* no queue sheet to check: treat as not a review message */ }
  return false;
}

// Returns true when the reply was handled here. A reply to a channel review message is left to the older status route.
function handleUnitReply(m) {
  if (!m.reply_to_message || !m.text || String(m.chat.id) !== REVIEWER_CHAT_ID) return false;
  const quoted = String(m.reply_to_message.text || m.reply_to_message.caption || '');
  const refMatch = quoted.match(/(?:\bRef:?|\bFound)\s+([A-Za-z][A-Za-z0-9]{0,5}-\d{4,6})\b/);
  if (!refMatch) return false;
  if (replyIsChannelReview(m.reply_to_message.message_id)) return false;
  const ref = refMatch[1];
  const text = String(m.text).trim();
  const status = parseUnitStatusText(text.replace(/^[#\/]?\s*(sold|rented)\b\s*$/i, '$1 ' + ref));
  if (status) { startUnitStatus(m.chat.id, status); return true; }
  const asPrice = /^\$\s*\d/.test(text) ? 'price now ' + text : text;
  const change = parsePriceUpdate(ref + ' ' + asPrice);
  if (change && change.newPrice) { startPriceUpdate(m.chat.id, change); return true; }
  return false;
}

// ── Sold / rented: take a unit off the website ──────────────────────────────────────
// "SOLD TS10-1021" (typed), or the existing SOLD / RENTED reply to a post that carries a Ref. The bot shows a card and
// changes the website only after a tap. A sold or rented unit disappears from every public page.

function unitStatusCache(id, verb) { return 'unitstat_' + id + '_' + verb; }

function parseUnitStatusText(text) {
  const t = String(text || '').trim();
  const m = t.match(/^[#\/]?\s*(sold|rented)\s*[:=]?\s+(?:ref\s*)?(?=[A-Za-z][A-Za-z0-9]{0,5}-\d{4,6}\b)/i);
  if (!m) return null;
  const ref = t.slice(m[0].length).match(/^([A-Za-z][A-Za-z0-9]{0,5})-(\d{4,6})\b/);
  if (!ref) return null;
  const n = parseInt(ref[2], 10) - 1000;
  if (!(n > 0)) return null;
  return { verb: m[1].toLowerCase(), id: n, ref: ref[0] };
}

function startUnitStatus(chatId, sc) {
  chatId = String(chatId);
  const r = callIntake({ action: 'lookup', id: sc.id });
  if (r.code === 404) { sendTelegramMessage(chatId, 'I could not find a single unit with the number ' + (sc.ref || (sc.id + 1000)) + '. Project pages are never changed this way.'); return; }
  if (r.code !== 200 || !r.body || !r.body.ok) { sendTelegramMessage(chatId, 'The website did not answer (' + r.code + '). Nothing was changed. Try again in a minute.'); return; }
  const u = r.body;
  const word = sc.verb === 'rented' ? 'Rented' : 'Sold';
  if (u.status !== 'active') {
    sendTelegramMessage(chatId, u.refCode + ' is not live on the website (' + (u.status === 'draft' ? 'hidden draft' : u.status) + '), so there is nothing to mark as ' + word.toLowerCase() + '.');
    return;
  }
  const st = { unitId: u.id, ref: u.refCode, title: u.title, verb: sc.verb, used: null };
  unitCache().put(unitStatusCache(u.id, sc.verb), JSON.stringify(st), UNIT_CACHE_SECONDS);
  unitSessionTouch();
  sendTelegramMessage(chatId,
    'Found ' + u.refCode + ': ' + u.title + '\n' + formatUsd(u.price) + (u.listingType === 'rent' ? '/month' : '') + '\n\nMark it as ' + word.toLowerCase() + '? Its page will disappear from the website (it can be brought back in the admin).',
    { inline_keyboard: [[{ text: 'Mark as ' + word + ' on website', callback_data: 'ustat_' + u.id + '_' + sc.verb + '_go' }, { text: 'Cancel', callback_data: 'ustat_' + u.id + '_' + sc.verb + '_no' }]] });
}

function handleUnitStatusCallback(cb, rest) {
  const chatId = cb.message && cb.message.chat ? String(cb.message.chat.id) : '';
  if (chatId !== REVIEWER_CHAT_ID) { answerCallback(cb.id, 'Not allowed.'); return; }
  const parts = String(rest).split('_');
  const raw = unitCache().get(unitStatusCache(parts[0], parts[1]));
  const st = raw ? JSON.parse(raw) : null;
  const messageId = cb.message.message_id;
  if (!st) { answerCallback(cb.id, 'This question expired. Send it again.'); return; }
  if (st.used) { answerCallback(cb.id, 'Already handled.'); return; }
  unitSessionTouch();
  if (parts[2] === 'no') {
    st.used = 'no'; unitCache().put(unitStatusCache(st.unitId, st.verb), JSON.stringify(st), UNIT_CACHE_SECONDS);
    answerCallback(cb.id, 'Cancelled.');
    editUnitMessage(chatId, messageId, 'Cancelled. The website was not changed.', null);
    return;
  }
  if (parts[2] !== 'go') { answerCallback(cb.id, ''); return; }
  st.used = 'go'; unitCache().put(unitStatusCache(st.unitId, st.verb), JSON.stringify(st), UNIT_CACHE_SECONDS);
  const r = callIntake({ action: 'status', id: st.unitId, expectedStatus: 'active', newStatus: st.verb });
  if (r.code !== 200 || !r.body || !r.body.ok) {
    st.used = null; unitCache().put(unitStatusCache(st.unitId, st.verb), JSON.stringify(st), UNIT_CACHE_SECONDS);
    answerCallback(cb.id, 'Failed.');
    editUnitMessage(chatId, messageId, r.code === 409 ? 'Nothing was changed. The unit is no longer live on the website.' : 'The website did not accept the change (' + r.code + '). Nothing was changed. Send it again to retry.', null);
    return;
  }
  answerCallback(cb.id, 'Done.');
  editUnitMessage(chatId, messageId, 'Done. ' + st.ref + ' is marked as ' + st.verb + ' and is off the website.', null);
}

// A channel only post (no Ref) can become a website page with one tap. The saved post text and photos start the normal draft.
function offerCreatePage(chatId, offer, allowCreate) {
  chatId = String(chatId);
  if (!allowCreate || !offer || !offer.content) {
    sendTelegramMessage(chatId, 'This post has no page on the website, so only the channel changed.');
    return;
  }
  let text = offer.content;
  if (offer.amount) {
    const newPrice = parseMoneyAmount(offer.amount[1], offer.amount[2]);
    if (newPrice > 0) text = text.replace(/\$\s*\d[\d,]*(?:\.\d+)?\s*[km]?/i, formatUsd(newPrice)); // the new price replaces the first (main) price
  }
  const m = { id: newUnitDraftId(), orig: { text: text, photoIds: offer.photoIds || [], isForwarded: false, sourceUsername: null, entities: null }, images: photosOnly(offer.photoIds), mediaGroupId: null, used: null };
  saveUnitMenu(m);
  unitSessionTouch();
  sendTelegramMessage(chatId, 'This post has no page on the website, so only the channel changed.\nCreate a website page from this post?',
    { inline_keyboard: [[{ text: 'Create a website page from this post', callback_data: 'menu_' + m.id + '_site' }]] });
}

// The channel post for a changed price, in the template the existing flow already reads.
function priceDropChannelText(st) {
  const building = String(st.title).split(' · ')[0];
  const studio = /studio/i.test(st.title) && !st.bedrooms;
  const facts = { price: st.newPrice, listingType: st.listingType, bedrooms: studio ? 0 : (st.bedrooms || null), bathrooms: st.bathrooms || null, sqm: st.sqm || 0, floor: st.floor || null };
  const d = { facts: facts, buildingName: building, location: st.location, city: st.city, features: [], extraFeatures: [], parentId: 1 };
  const text = unitFactsToChannelText(d);
  if (st.newPrice < st.oldPrice) return text + '\n✅ Price reduced from ' + formatUsd(st.oldPrice) + (st.listingType === 'rent' ? '/month' : '');
  return text;
}

// Adds the live page link and the reference code to a finished channel post, just above the contact block.
function addPageLink(content, pageUrl, refCode) {
  if (!pageUrl) return content;
  const marker = '――――――――――\n' + CONTACT_STANDARD;
  const extra = '🔗 ' + pageUrl; // the unit's number is at the end of the address, so no separate code line is needed
  const at = content.lastIndexOf(marker);
  if (at === -1) return content + '\n\n' + extra;
  return content.slice(0, at) + extra + '\n\n' + content.slice(at);
}

// Edits an existing bot message's text and buttons (pass null to remove the buttons).
function editUnitMessage(chatId, messageId, text, replyMarkup) {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  const payload = { chat_id: String(chatId), message_id: String(messageId), text: text }; // strings on purpose, see startWebsiteDraft
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  else payload.reply_markup = JSON.stringify({ inline_keyboard: [] });
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  // "message is not modified" is harmless (a tap that changed nothing).
  if (!data.ok && String(data.description || '').indexOf('not modified') === -1) Logger.log('editUnitMessage failed: ' + resp.getContentText());
}
