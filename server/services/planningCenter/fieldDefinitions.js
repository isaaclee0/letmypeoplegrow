const { httpsGet } = require('../planningCenterSync');

// Fetch PCO custom Tab field definitions, restricted to bounded-value types
// (select/checkboxes) — the only types the sync filter UI offers, since free-text and
// date fields have unbounded value sets. Per PCO's own API docs, the multi-select
// checkbox data type is "checkboxes" (plural) — a single checkbox toggle isn't one of
// the field_definition data types.
//
// Also resolves each field's admin-defined option list (via include=field_options),
// so the filter UI can offer every value a church has configured — not just values
// some currently-synced person happens to have selected.
async function fetchFieldDefinitions(accessToken) {
  const results = [];
  let next = 'https://api.planningcenteronline.com/people/v2/field_definitions?per_page=100&include=tab,field_options';
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
    const optionsByDefId = new Map();
    for (const inc of data.included || []) {
      if (inc.type === 'Tab') {
        tabNameById.set(inc.id, inc.attributes.name);
      } else if (inc.type === 'FieldOption') {
        const defId = inc.relationships && inc.relationships.field_definition
          && inc.relationships.field_definition.data && inc.relationships.field_definition.data.id;
        if (!defId) continue;
        if (!optionsByDefId.has(defId)) optionsByDefId.set(defId, []);
        optionsByDefId.get(defId).push({ value: inc.attributes.value, sequence: inc.attributes.sequence || 0 });
      }
    }
    for (const raw of data.data || []) {
      const dataType = raw.attributes && raw.attributes.data_type;
      if (dataType !== 'select' && dataType !== 'checkboxes') continue;
      const tabId = raw.relationships && raw.relationships.tab && raw.relationships.tab.data && raw.relationships.tab.data.id;
      const options = (optionsByDefId.get(raw.id) || [])
        .sort((a, b) => a.sequence - b.sequence)
        .map((o) => o.value);
      results.push({
        id: raw.id,
        name: raw.attributes.name,
        dataType,
        tabName: (tabId && tabNameById.get(tabId)) || null,
        options,
      });
    }
    next = (data.links && data.links.next) || null;
  }
  return results;
}

module.exports = { fetchFieldDefinitions };
