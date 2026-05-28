// autoFirstContactService.js
// Issue #3 — שליחת הודעת WhatsApp ראשונה אוטומטית לכל מפרסם חדש
// Issue #5 — כינוסי נכסים: פנייה אוטומטית, סינון קווי ארץ
// P0 - דחוף ביותר

const pool = require('../db/pool');
const axios = require('axios');

const INFORU_USERNAME = process.env.INFORU_USERNAME || 'hemichaeli';
const INFORU_TOKEN = process.env.INFORU_TOKEN || '95452ace-07cf-48be-8671-a197c15d3c17';
const INFORU_BUSINESS_LINE = process.env.INFORU_BUSINESS_LINE || '037572229';
const INFORU_API_URL = 'https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat';

// Valid Israeli mobile carrier prefixes (Ministry of Communications, 2026):
//   050 Pelephone, 052 Cellcom, 053 Hot Mobile, 054 Partner,
//   055 multi-MVNO (Hot/Rami Levy/Golan/We4G), 058 multi-MVNO.
// Invalid/reserved: 056, 057, 059.
// Verified 2026-05-25: InforU returns StatusId -33 InvalidPhoneNumber for 059X,
// so we filter these out client-side instead of repeatedly hitting the API.
const ISRAELI_MOBILE_PREFIX = /^(050|052|053|054|055|058)\d{7}$/;
const ISRAELI_MOBILE_INTL = /^972(50|52|53|54|55|58)\d{7}$/;

function isMobilePhone(phone) {
    if (!phone) return false;
    const clean = phone.replace(/[^0-9]/g, '');
    return ISRAELI_MOBILE_PREFIX.test(clean) || ISRAELI_MOBILE_INTL.test(clean);
}

// נקה מספר טלפון לפורמט בינלאומי
function normalizePhone(phone) {
    if (!phone) return null;
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) clean = '972' + clean.substring(1);
    if (!clean.startsWith('972')) clean = '972' + clean;
    return clean;
}

// בנה הודעה ראשונה לפי סוג מקור וכתובת הנכס
function buildFirstMessage(listing, source) {
    const location = listing.address || listing.city || 'האזור שלך';
    const city = listing.city || '';

    if (source === 'facebook') {
        return `שלום! ראינו את המודעה שלך ב-${location}${city ? ` (${city})` : ''}.

אנחנו QUANTUM – משרד תיווך המתמחה בפינוי-בינוי ויש לנו קונים רציניים שמחפשים נכסים בדיוק באזור שלך.

האם תרצה לשמוע יותר? אנחנו מטפלים בהכל ובצורה מקצועית.`;
    }

    if (source === 'kones') {
        return `שלום, ראינו שיש נכס בכינוס נכסים ב${location}${city ? `, ${city}` : ''}.

אנחנו QUANTUM ומתמחים בפינוי-בינוי ויש לנו קונים מעוניינים. האם תרצה לשוחח?`;
    }

    // יד2 default
    return `שלום! ראינו את המודעה שלך ביד2 ב${location}${city ? `, ${city}` : ''}.

אנחנו QUANTUM – משרד תיווך המתמחה בעסקאות פינוי-בינוי. יש לנו קונים מאומתים שמחפשים נכסים בדיוק באזור זה.

האם תרצה לשמוע על האפשרויות? נשמח לסייע.`;
}

// Cold first-contact via INFORU.
//
// PRIMARY: WhatsApp template `seller_outreach_v1` (Meta-approved 2026-04-29,
// templateId 255220). Has two quick-reply buttons: "כן, אשמח לשמוע" and
// "אנא הסירו אותי". Works for cold numbers because Meta only restricts FREE
// chat outside the 24h window — approved templates can be sent any time.
//
// FALLBACK: SMS via InforU XML endpoint, used only if the WhatsApp template
// send itself errors (recipient not on WhatsApp, blocked, etc.).
async function sendWhatsApp(phone, message, listing) {
    try {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return { success: false, error: 'Invalid phone number' };

        const inforu = require('./inforuService');

        // Build location string for {{1}}. Address first, fall back to city only.
        const address = (listing?.address || '').trim();
        const city = (listing?.city || '').trim();
        let location;
        if (address && city && !address.includes(city)) location = `${address}, ${city}`;
        else if (address) location = address;
        else if (city) location = city;
        else location = 'באזור שלך';

        // 1) Try Meta-approved template (works for cold numbers).
        try {
            const waResult = await inforu.sendWhatsApp(cleanPhone, 'seller_outreach_v1', { location }, {
                customerParameter: 'QUANTUM_AUTO_FIRST_CONTACT',
                listingId: listing?.id || null
            });
            if (waResult?.success) {
                return { success: true, channel: 'whatsapp_template', status: waResult.status, data: waResult };
            }
            console.warn(`[AutoFirstContact] WhatsApp template failed for ${cleanPhone} (${waResult?.description || 'unknown'}), trying SMS`);
        } catch (waErr) {
            console.warn(`[AutoFirstContact] WhatsApp template error for ${cleanPhone}: ${waErr.message}, trying SMS`);
        }

        // 2) Fallback to SMS (legacy free-text path, no template needed).
        const smsResult = await inforu.sendSms(cleanPhone, message, {
            customerParameter: 'QUANTUM_AUTO_FIRST_CONTACT'
        });
        return {
            success: !!smsResult?.success,
            channel: 'sms',
            status: smsResult?.status || null,
            data: smsResult,
            error: smsResult?.success ? null : (smsResult?.description || 'SMS send failed')
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// שמור הודעה יוצאת ב-DB
async function saveOutgoingMessage(phone, message, listingId) {
    try {
        await pool.query(
            `INSERT INTO whatsapp_messages (phone, message, direction, message_type, created_at)
             VALUES ($1, $2, 'outgoing', 'text', NOW()) ON CONFLICT DO NOTHING`,
            [phone, message]
        ).catch(() => null);

        if (listingId) {
            await pool.query(
                `INSERT INTO listing_messages (listing_id, message_text, direction, status, created_at)
                 VALUES ($1, $2, 'outgoing', 'sent', NOW())`,
                [listingId, message]
            ).catch(() => null);
        }

        await pool.query(
            `INSERT INTO whatsapp_conversations (phone, status, updated_at)
             VALUES ($1, 'active', NOW())
             ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()`,
            [phone]
        ).catch(() => null);
    } catch (err) {
        console.warn('[AutoFirstContact] saveOutgoingMessage error:', err.message);
    }
}

// עבד מודעות יד2 חדשות שלא פנינו אליהן.
// DISTINCT ON (phone) — one advertiser, one outreach (verified 2026-05-25:
// phone 0528788858 got 4 SMS in 30s because it had 4 listings in קריית אונו).
// Phones in phone_blocklist (mass aggregators, opt-outs) are excluded.
// Order: hottest complex tier first so deals closest to closing get the limited
// daily template volume.
async function processYad2() {
    let contacted = 0, failed = 0, skipped = 0, dedupedSiblings = 0;
    // 2026-05-29: KILL SWITCH after Meta InforU WA platform restriction notice.
    // While the WABA quality is at risk, do not send any cold first-contact —
    // not via WhatsApp template, not via SMS fallback. Re-enable only after
    // the InforU app restriction is resolved and policy/consent are validated.
    if (process.env.AUTO_FIRST_CONTACT_KILL === '1') {
        console.warn('[AutoFirstContact] KILLED — AUTO_FIRST_CONTACT_KILL=1, no sends this tick');
        return { contacted: 0, failed: 0, skipped: 0, killed: true };
    }
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (l.phone)
                   l.id, l.phone, l.address, l.city, l.contact_name,
                   LEAST(5,
                     CASE
                       WHEN c.approval_date    IS NOT NULL OR c.signature_percent >= 85 THEN 5
                       WHEN c.deposit_date     IS NOT NULL OR c.signature_percent >= 65 THEN 4
                       WHEN c.submission_date  IS NOT NULL OR c.signature_percent >= 45 THEN 3
                       WHEN c.declaration_date IS NOT NULL OR c.signature_percent >= 25 THEN 2
                       ELSE 1
                     END
                     + CASE WHEN c.multiplier >= 2.5 THEN 1 ELSE 0 END
                   ) AS heat_tier
            FROM listings l
            JOIN complexes c ON c.id = l.complex_id
            LEFT JOIN phone_blocklist b ON b.phone = l.phone
            LEFT JOIN wa_optouts       o ON o.phone = l.phone
            WHERE l.contact_status IS NULL
              AND l.phone IS NOT NULL AND l.phone != ''
              AND l.is_active = TRUE
              AND l.complex_id IS NOT NULL
              AND b.phone IS NULL
              AND o.phone IS NULL
            ORDER BY l.phone, l.created_at DESC
            LIMIT 20
        `);
        // Re-sort the de-duped result by heat_tier desc so the WhatsApp
        // template budget goes to the hottest complexes first within this tick.
        result.rows.sort((a, b) => (b.heat_tier || 0) - (a.heat_tier || 0));

        for (const listing of result.rows) {
            try {
                // Skip landlines
                if (!isMobilePhone(listing.phone)) {
                    // Landline — WhatsApp/SMS won't reach. Route to Vapi instead
                    // (per CLAUDE.md Auto-Dialer Integration). Best-effort: any
                    // failure here just leaves the listing marked 'landline' so
                    // it doesn't return to the queue.
                    await pool.query(
                        `UPDATE listings SET contact_status = 'landline', updated_at = NOW() WHERE phone = $1`,
                        [listing.phone]
                    ).catch(() => null);
                    skipped++;
                    try {
                        // Dedup against prior Vapi calls for the same phone+agent.
                        // We use the existing vapi_calls table (consistent with
                        // vapiRoutes.js + reminderJob.js); the 'pinuy_binuy_landline'
                        // agent_type identifies calls placed by this code path.
                        const dedup = await pool.query(
                            `SELECT id FROM vapi_calls
                             WHERE phone = $1 AND agent_type = 'pinuy_binuy_landline'
                             LIMIT 1`,
                            [listing.phone]
                        );
                        if (dedup.rowCount === 0) {
                            const vapi = require('./vapiCampaignService');
                            const call = await vapi.placeVapiCall({
                                phone: listing.phone,
                                leadName: listing.contact_name || '',
                                leadCity: listing.city || '',
                                scriptType: 'pinuy_binuy',
                                campaignLeadId: listing.id,
                                campaignId: null,
                            });
                            await pool.query(
                                `INSERT INTO vapi_calls
                                   (call_id, phone, agent_type, lead_id, status, metadata, created_at)
                                 VALUES ($1, $2, 'pinuy_binuy_landline', $3, $4, $5, NOW())`,
                                [
                                    call.callId,
                                    listing.phone,
                                    listing.id,
                                    call.status || 'queued',
                                    JSON.stringify({
                                        source: 'auto_first_contact',
                                        address: listing.address,
                                        city: listing.city,
                                        heat_tier: listing.heat_tier,
                                    }),
                                ]
                            ).catch(err => console.warn(`[AutoFirstContact] vapi_calls log failed: ${err.message}`));
                            console.log(`[AutoFirstContact] LANDLINE → Vapi tier${listing.heat_tier || '?'}: ${listing.phone} (${listing.address}) call_id=${call.callId}`);
                        } else {
                            console.log(`[AutoFirstContact] LANDLINE already-queued: ${listing.phone}`);
                        }
                    } catch (vapiErr) {
                        console.warn(`[AutoFirstContact] Vapi landline call failed for ${listing.phone}: ${vapiErr.message}`);
                    }
                    continue;
                }

                const message = buildFirstMessage(listing, 'yad2');
                const res = await sendWhatsApp(listing.phone, message, listing);

                if (res.success) {
                    await pool.query(
                        `UPDATE listings SET contact_status = 'contacted',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW(), message_status = 'sent'
                         WHERE id = $1`,
                        [listing.id]
                    );
                    // Mark sibling listings (same phone) as contacted via this one
                    const siblings = await pool.query(
                        `UPDATE listings SET contact_status = 'contacted_via_sibling',
                         last_contact_at = NOW()
                         WHERE phone = $1 AND id <> $2 AND contact_status IS NULL`,
                        [listing.phone, listing.id]
                    );
                    if (siblings.rowCount > 0) dedupedSiblings += siblings.rowCount;
                    await saveOutgoingMessage(listing.phone, message, listing.id);
                    contacted++;
                    console.log(`[AutoFirstContact] OK Yad2 tier${listing.heat_tier || '?'}: ${listing.phone} (${listing.address})${siblings.rowCount ? ` +${siblings.rowCount} siblings` : ''}`);
                } else {
                    await pool.query(
                        `UPDATE listings SET contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW() WHERE id = $1`,
                        [listing.id]
                    );
                    failed++;
                    console.warn(`[AutoFirstContact] FAIL Yad2: ${listing.phone} — ${res.error}`);
                }

                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                failed++;
                console.warn(`[AutoFirstContact] Error listing ${listing.id}:`, e.message);
            }
        }
        if (dedupedSiblings > 0) console.log(`[AutoFirstContact] De-duped ${dedupedSiblings} sibling listings (same advertiser)`);
    } catch (e) {
        console.error('[AutoFirstContact] processYad2 error:', e.message);
    }
    return { contacted, failed, skipped };
}

// עבד מודעות פייסבוק חדשות שלא פנינו אליהן
async function processFacebook() {
    let contacted = 0, failed = 0, skipped = 0;
    try {
        const tableCheck = await pool.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'facebook_ads'`
        );
        if (!tableCheck.rows.length) return { contacted: 0, failed: 0, skipped: 0 };

        // Day 8.5 fix: removed the 2-hour window (same as Yad2 path).
        const result = await pool.query(`
            SELECT id, phone, address, city, contact_name
            FROM facebook_ads
            WHERE contact_status IS NULL
              AND phone IS NOT NULL AND phone != ''
            ORDER BY created_at DESC
            LIMIT 20
        `).catch(() => ({ rows: [] }));

        for (const ad of result.rows) {
            try {
                if (!isMobilePhone(ad.phone)) {
                    await pool.query(
                        `UPDATE facebook_ads SET contact_status = 'landline', updated_at = NOW() WHERE id = $1`,
                        [ad.id]
                    ).catch(() => null);
                    skipped++;
                    continue;
                }

                const message = buildFirstMessage(ad, 'facebook');
                const res = await sendWhatsApp(ad.phone, message, ad);
                if (res.success) {
                    await pool.query(
                        `UPDATE facebook_ads SET contact_status = 'contacted',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW() WHERE id = $1`,
                        [ad.id]
                    );
                    await saveOutgoingMessage(ad.phone, message, null);
                    contacted++;
                } else {
                    failed++;
                }
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) { failed++; }
        }
    } catch (e) {
        console.error('[AutoFirstContact] processFacebook error:', e.message);
    }
    return { contacted, failed, skipped };
}

// פנייה אוטומטית לכינוסי נכסים חדשים - רק מספרי נייד
async function runKonesAutoContact() {
    if (process.env.AUTO_FIRST_CONTACT_KILL === '1') {
        console.warn('[KonesContact] KILLED — AUTO_FIRST_CONTACT_KILL=1');
        return { contacted: 0, failed: 0, skipped_landline: 0, skipped_no_phone: 0, killed: true };
    }
    let contacted = 0, failed = 0, skipped_landline = 0, skipped_no_phone = 0;
    try {
        // Get all uncontacted active kones listings
        const result = await pool.query(`
            SELECT id, phone, address, city, contact_person
            FROM kones_listings
            WHERE contact_status IS NULL
              AND is_active = TRUE
            LIMIT 50
        `).catch(() => ({ rows: [] }));

        console.log(`[KonesContact] Found ${result.rows.length} uncontacted listings`);

        for (const k of result.rows) {
            try {
                // No phone at all
                if (!k.phone || k.phone.trim() === '') {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'no_phone', updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    ).catch(() => null);
                    skipped_no_phone++;
                    continue;
                }

                // Landline - skip WhatsApp but note it for phone follow-up
                if (!isMobilePhone(k.phone)) {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'landline',
                         updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    ).catch(() => null);
                    skipped_landline++;
                    console.log(`[KonesContact] LANDLINE (phone call needed): ${k.phone} — ${k.city} ${k.address}`);
                    continue;
                }

                // Mobile number - send WhatsApp
                const message = buildFirstMessage(k, 'kones');
                const res = await sendWhatsApp(k.phone, message, k);
                if (res.success) {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'contacted',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW(), updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    );
                    await saveOutgoingMessage(k.phone, message, null);
                    contacted++;
                    console.log(`[KonesContact] OK: ${k.phone} (${k.address}, ${k.city})`);
                } else {
                    await pool.query(
                        `UPDATE kones_listings SET contact_status = 'failed',
                         contact_attempts = COALESCE(contact_attempts, 0) + 1,
                         last_contact_at = NOW(), updated_at = NOW() WHERE id = $1`,
                        [k.id]
                    ).catch(() => null);
                    failed++;
                    console.warn(`[KonesContact] FAIL: ${k.phone} — ${res.error}`);
                }
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                failed++;
                console.warn(`[KonesContact] Error id=${k.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[KonesContact] error:', e.message);
    }
    const summary = { contacted, failed, skipped_landline, skipped_no_phone };
    console.log(`[KonesContact] Done:`, summary);
    return summary;
}

// הפעל את כל הפניות הראשונות (יד2 + פייסבוק)
async function runAutoFirstContact() {
    // 2026-05-29: outer kill switch. While the Meta InforU WA platform
    // restriction notice is open, the entire run is a no-op. We log so the
    // 30-min cron heartbeat is still visible.
    if (process.env.AUTO_FIRST_CONTACT_KILL === '1') {
        console.warn('[AutoFirstContact] KILLED — AUTO_FIRST_CONTACT_KILL=1, run aborted before any sends');
        return { contacted: 0, failed: 0, skipped: 0, killed: true };
    }
    console.log('[AutoFirstContact] Starting run...');
    const yad2 = await processYad2();
    const fb = await processFacebook();
    const total = {
        contacted: yad2.contacted + fb.contacted,
        failed: yad2.failed + fb.failed,
        skipped: (yad2.skipped || 0) + (fb.skipped || 0)
    };
    console.log(`[AutoFirstContact] Done — contacted: ${total.contacted}, failed: ${total.failed}, skipped(landlines): ${total.skipped}`);
    return total;
}

// סטטיסטיקות לדשבורד
async function getContactStats() {
    try {
        const [pending, contacted, total] = await Promise.all([
            pool.query(`SELECT COUNT(*) FROM listings WHERE contact_status IS NULL AND phone IS NOT NULL AND phone != '' AND is_active = TRUE`),
            pool.query(`SELECT COUNT(*) FROM listings WHERE contact_status = 'contacted'`),
            pool.query(`SELECT COUNT(*) FROM listings WHERE phone IS NOT NULL AND phone != '' AND is_active = TRUE`)
        ]);
        return {
            pending: parseInt(pending.rows[0].count) || 0,
            contacted: parseInt(contacted.rows[0].count) || 0,
            total: parseInt(total.rows[0].count) || 0
        };
    } catch (e) {
        return { pending: 0, contacted: 0, total: 0 };
    }
}

// סטטיסטיקות כינוסים
async function getKonesContactStats() {
    try {
        const result = await pool.query(`
            SELECT
                contact_status,
                COUNT(*) as count
            FROM kones_listings
            WHERE is_active = TRUE
            GROUP BY contact_status
            ORDER BY count DESC
        `).catch(() => ({ rows: [] }));

        const stats = {
            total: 0,
            contacted: 0,
            landline: 0,
            no_phone: 0,
            failed: 0,
            pending: 0
        };

        for (const row of result.rows) {
            const status = row.contact_status || 'pending';
            const count = parseInt(row.count);
            stats[status] = count;
            stats.total += count;
        }

        return stats;
    } catch (e) {
        return { total: 0, contacted: 0, landline: 0, no_phone: 0, failed: 0, pending: 0 };
    }
}

// אתחול — נקרא מ-index.js בהפעלה
async function initialize() {
    console.log('[AutoFirstContact] Service initialized');
    return true;
}

module.exports = { initialize, runAutoFirstContact, runKonesAutoContact, getContactStats, getKonesContactStats, isMobilePhone };
