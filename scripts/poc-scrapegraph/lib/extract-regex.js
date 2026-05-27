/**
 * Path A — regex extraction.
 *
 * Ported verbatim from src/services/komoDirectScraper.js#fetchListingDetails
 * (commit at PoC time). Phone is NOT in the HTML; production code fetches
 * it from a separate JSON phone-reveal API. For an apples-to-apples HTML
 * extraction comparison, phone is left null in all three paths.
 */

const { canonicalize } = require('./schema');

function extractRegex(html, modaaNum) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const titleText = titleMatch ? titleMatch[1] : '';

  const cityMatch = titleText.match(/ב([^,]+),/);
  let city = cityMatch ? cityMatch[1].trim() : '';
  city = city.replace(/^.*ב/, '').trim();

  const neighMatch = titleText.match(
    /,\s*([^,\d]+?)\s+(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)/
  );
  const neighborhood = neighMatch ? neighMatch[1].trim() : '';

  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const h1Text = h1Match ? h1Match[1].trim() : '';

  const address = neighborhood ? `${neighborhood}, ${city}` : (city || null);

  const priceMatch = html.match(/([\d,]+)\s*₪/);
  const asking_price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null;

  const roomsMatch = html.match(/(\d+\.?\d*)\s*חד/);
  const rooms = roomsMatch ? parseFloat(roomsMatch[1]) : null;

  const sqmMatch = html.match(/(\d+)\s*מ['"]{0,2}ר/);
  const area_sqm = sqmMatch ? parseInt(sqmMatch[1], 10) : null;

  const floorMatch = html.match(/קומה[:\s]*(\d+)/);
  const floor = floorMatch ? parseInt(floorMatch[1], 10) : null;

  const descMatch = html.match(/תיאור הנכס[:\s]*<\/[^>]+>\s*<[^>]+>([^<]{10,})/);
  const description = descMatch ? descMatch[1].trim().substring(0, 500) : null;

  return canonicalize({
    address,
    city: city || null,
    asking_price,
    rooms,
    area_sqm,
    floor,
    phone: null,
    contact_name: null,
    title: titleText || h1Text || null,
    description,
    source_listing_id: modaaNum
  });
}

module.exports = { extractRegex };
