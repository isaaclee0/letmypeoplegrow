const { httpsGet } = require('../planningCenterSync');

// Fetch PCO custom Tab field definitions, restricted to bounded-value types
// (select/checkbox) — the only types the sync filter UI offers, since free-text and
// date fields have unbounded value sets.
async function fetchFieldDefinitions(accessToken) {
  const results = [];
  let next = 'https://api.planningcenteronline.com/people/v2/field_definitions?per_page=100&include=tab';
  let pages = 0;
  while (next) {
    if (++pages > 1000) {
      throw new Error('PCO field_definitions fetch exceeded 1000 pages — aborting to avoid an unbounded loop');
    }
    const resp = await httpsGet(next, accessToken);
    if (resp.status !== 200) {
      throw new Error(`PCO field_definitions fetch failed (status ${resp.status})`);
    }
    const data = resp.data;
    const tabNameById = new Map();
    for (const inc of data.included || []) {
      if (inc.type === 'Tab') tabNameById.set(inc.id, inc.attributes.name);
    }
    for (const raw of data.data || []) {
      const dataType = raw.attributes && raw.attributes.data_type;
      if (dataType !== 'select' && dataType !== 'checkbox') continue;
      const tabId = raw.relationships && raw.relationships.tab && raw.relationships.tab.data && raw.relationships.tab.data.id;
      results.push({
        id: raw.id,
        name: raw.attributes.name,
        dataType,
        tabName: (tabId && tabNameById.get(tabId)) || null,
      });
    }
    next = (data.links && data.links.next) || null;
  }
  return results;
}

module.exports = { fetchFieldDefinitions };
