/* SPA shell: hash routing + the four views (spec §26). */

import { api } from './api.js';
import { closeModal, initModal, openCard } from './modal.js';
import { cardArt, el, esc, eur, hofBadge, lineChart, pct, photoUrl, placeholder,
         progressBar, toast } from './ui.js';

const view = () => document.getElementById('view');
let META = null;

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    META = await api.meta();
  } catch (e) {
    view().innerHTML = `<div class="empty">No se pudo contactar con la API.<br><small>${esc(e.message)}</small></div>`;
    return;
  }
  initModal(META, () => render(true));
  stampVersion();
  wireSearch();
  // A route change must dismiss the modal, or it lingers over the new view.
  window.addEventListener('hashchange', () => { closeModal(); render(); });
  render();
}

/* Which build is being served. Without it, "it still shows the old price" is
   ambiguous between a bug and an image that was never rebuilt. */
function stampVersion() {
  if (!META.version) return;
  const el = document.createElement('span');
  el.className = 'build-stamp';
  el.textContent = META.version;
  el.title = 'Build en ejecución';
  document.querySelector('.topbar')?.appendChild(el);
}

function route() {
  const [path, query] = (location.hash.slice(2) || 'dashboard').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'dashboard', id: parts[1], params: new URLSearchParams(query || '') };
}

const VIEWS = { dashboard, sets, set: setDetail, cartas: collection,
                collection, missing, mantenimiento };   // /collection kept as an alias

async function render(keepScroll = false) {
  const r = route();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle(
    'active', a.dataset.tab === r.name
      || (r.name === 'set' && a.dataset.tab === 'sets')
      || (r.name === 'collection' && a.dataset.tab === 'cartas')));
  const y = keepScroll ? window.scrollY : 0;
  const fn = VIEWS[r.name] || dashboard;
  view().innerHTML = '<div class="loading">Cargando…</div>';
  try {
    await fn(r);
  } catch (e) {
    view().innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
  window.scrollTo(0, y);
}

/* ------------------------------------------------------------- dashboard */
async function dashboard() {
  const [d, hist] = await Promise.all([api.dashboard(), api.history()]);
  const v = d.value;
  const points = hist.data.map((s) => ({ label: s.captured_on.slice(5), value: s.value_eur }));

  view().innerHTML = `
    <h1>Mi colección</h1>
    <p class="sub">${d.unique_cards} cartas únicas · ${d.physical_cards} cartas físicas ·
       ${d.sets_total} sets · ${pct(d.completion_pct)} únicas · ${pct(d.copies_pct)} copias</p>

    <div class="stat-grid">
      <div class="stat accent"><div class="k">Valor estimado</div>
        <div class="v">${esc(eur(v.total_eur))}</div>
        ${v.unpriced_items ? `<div class="note">${v.unpriced_items} sin precio conocido</div>` : ''}</div>
      <div class="stat"><div class="k">Cartas únicas</div><div class="v">${d.unique_cards}</div></div>
      <div class="stat"><div class="k">Cartas físicas</div><div class="v">${d.physical_cards}</div></div>
      <div class="stat"><div class="k">Sets completos</div>
        <div class="v">${d.sets_complete}<small> / ${d.sets_total}</small></div></div>
      <div class="stat"><div class="k">Completitud (únicas)</div>
        <div class="v">${pct(d.completion_pct)}</div>
        ${progressBar(d.owned_cards, d.target_cards)}
        <div class="note">${d.owned_cards} / ${d.target_cards} cartas distintas</div></div>
      <div class="stat"><div class="k">Completitud (copias)</div>
        <div class="v">${pct(d.copies_pct)}</div>
        ${progressBar(d.copies_held, d.copies_target)}
        <div class="note">${d.copies_held} / ${d.copies_target} copias objetivo</div></div>
    </div>

    <h2>Evolución del valor</h2>
    ${lineChart(points)}
    ${points.length < 2 ? '<div class="note">El histórico se acumula con cada snapshot mensual.</div>' : ''}

    <h2>Sets más completos</h2>
    <div class="set-grid">${d.most_complete.map(setCardHtml).join('')}</div>

    <h2>Sets con más cartas faltantes</h2>
    <div class="set-grid">${d.most_missing.map(setCardHtml).join('')}</div>

    <h2>Cartas de mayor valor</h2>
    <div class="missing-list">${
      d.top_value.length ? d.top_value.map((t) => `
        <div class="missing-row" data-card="${esc(t.card_id)}">
          <span class="n">#${esc(t.number)}</span>
          <span>${esc(t.name)}</span>
          <span class="tag">${esc(t.variant)} · ${esc(t.condition)} · ×${t.quantity}</span>
          <span class="r">${esc(eur(t.value))}</span>
        </div>`).join('')
      : '<div class="empty">Todavía no hay precios. Ejecuta una actualización de precios.</div>'}</div>

    <div class="btn-row">
      <button class="btn" id="refresh-prices">Actualizar precios ahora</button>
      <span class="note" style="align-self:center">
        Última actualización: ${esc(d.last_price_refresh || 'nunca')}</span>
    </div>`;

  wireCardClicks();
  view().querySelectorAll('[data-set]').forEach((n) => {
    n.onclick = () => { location.hash = `#/set/${n.dataset.set}`; };
  });
  view().querySelector('#refresh-prices').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Actualizando…';
    try {
      const r = await api.refreshPrices();
      toast(`${r.updated} precios actualizados${r.unpriced ? `, ${r.unpriced} sin datos` : ''}`);
      render();
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
      e.target.textContent = 'Actualizar precios ahora';
    }
  };
}

const setCardHtml = (s) => `
  <div class="set-card" data-set="${esc(s.id)}">
    <span class="pct">${pct(s.completion_pct)}</span>
    <div class="name">${esc(s.name)}</div>
    <div class="count">${s.owned} / ${s.target} cartas${
      s.missing ? ` · faltan ${s.missing}` : ''}</div>
    ${progressBar(s.owned, s.target)}
  </div>`;

/* ------------------------------------------------------------------ sets */
async function sets() {
  const { data } = await api.sets();
  const groups = {};
  for (const s of data) (groups[s.group_name || 'Otros'] ||= []).push(s);

  view().innerHTML = `
    <h1>Sets</h1>
    <p class="sub">${data.length} sets personalizados ·
       ${data.reduce((a, s) => a + s.owned, 0)} / ${data.reduce((a, s) => a + s.target, 0)} cartas</p>
    ${Object.entries(groups).map(([g, list]) => `
      <h2>${esc(g)}</h2>
      <div class="set-grid">${list.map((s) => setCardHtml({
        ...s, missing: s.target - s.owned })).join('')}</div>`).join('')}`;

  view().querySelectorAll('[data-set]').forEach((n) => {
    n.onclick = () => { location.hash = `#/set/${n.dataset.set}`; };
  });
}

/* ------------------------------------------------------- set detail grid */
async function setDetail(r) {
  const s = await api.set(r.id);
  const p = s.progress || { owned: 0, target: 0, completion_pct: 0 };
  const sort = r.params.get('sort') || 'number';
  const filter = r.params.get('filter') || 'all';

  const counts = {
    all: s.slots.length,
    owned: s.slots.filter((x) => x.owned).length,
    missing: s.slots.filter((x) => !x.owned).length,
  };

  let slots = [...s.slots];
  if (filter === 'owned') slots = slots.filter((x) => x.owned);
  if (filter === 'missing') slots = slots.filter((x) => !x.owned);
  // Cards the rule left out are not slots — they are shown so that nothing in
  // the set is invisible, and so one can be brought in without touching the
  // rule. A rule that removes eighteen cards should not hide them.
  if (filter === 'excluded') {
    slots = (s.excluded || []).map((c) => ({
      card_id: c.id, label: c.name, name: c.name, number: c.number,
      rarity: c.rarity, image_small_url: c.image_small_url,
      image_local: c.image_local, official_set_id: c.official_set_id,
      owned: 0, quantity: 0, target: 1, complete: 0, excluded: true,
    }));
  }
  slots.sort(sorter(sort));

  view().innerHTML = `
    <h1>${esc(s.name)}</h1>
    <p class="sub">${p.owned} / ${p.target} cartas · ${pct(p.completion_pct)} completado${
      s.description ? ` · ${esc(s.description)}` : ''}</p>
    ${progressBar(p.owned, p.target)}

    <div class="toolbar">
      <div class="chips seg" id="f-filter">
        ${[['all', 'Todas'], ['owned', 'Poseídas'], ['missing', 'Faltantes']]
          .map(([k, label]) => `<span class="chip${filter === k ? ' on' : ''}"
             data-filter="${k}">${label}<b>${counts[k]}</b></span>`).join('')}
        ${(s.excluded && s.excluded.length) ? `
        <span class="chip${filter === 'excluded' ? ' on' : ''}" data-filter="excluded"
              title="Cartas del set que la regla de este set deja afuera">
          Fuera de la regla<b>${s.excluded.length}</b></span>` : ''}
      </div>
      <select id="f-sort">
        <option value="number"${sort === 'number' ? ' selected' : ''}>Por número</option>
        <option value="name"${sort === 'name' ? ' selected' : ''}>Por nombre</option>
        <option value="rarity"${sort === 'rarity' ? ' selected' : ''}>Por rareza</option>
        <option value="owned"${sort === 'owned' ? ' selected' : ''}>Poseídas primero</option>
      </select>
      <span class="spacer">${slots.length} cartas mostradas</span>
    </div>

    <div class="card-grid">${slots.map(slotHtml).join('')}</div>`;

  const nav = (f) => {
    location.hash = `#/set/${r.id}?sort=${view().querySelector('#f-sort').value}&filter=${f}`;
  };
  view().querySelector('#f-sort').onchange = () => nav(filter);
  view().querySelectorAll('#f-filter .chip').forEach((chip) => {
    chip.onclick = () => nav(chip.dataset.filter);
  });
  wireCardClicks();
}

const sorter = (key) => ({
  number: (a, b) => (a.number_sort ?? 0) - (b.number_sort ?? 0),
  name: (a, b) => String(a.label).localeCompare(String(b.label)),
  rarity: (a, b) => String(a.rarity || '').localeCompare(String(b.rarity || ''))
                    || (a.number_sort ?? 0) - (b.number_sort ?? 0),
  owned: (a, b) => (b.owned ? 1 : 0) - (a.owned ? 1 : 0) || (a.number_sort ?? 0) - (b.number_sort ?? 0),
}[key] || ((a, b) => (a.number_sort ?? 0) - (b.number_sort ?? 0)));

function slotHtml(slot) {
  const art = cardArt(slot);
  // Holding a copy lifts the greyed-out treatment; reaching the target earns the
  // tick. A card you have one of but want three of is neither missing nor done.
  const complete = !!slot.complete;
  // Missing cards show their art too, dimmed and hatched by CSS, so the set
  // reads as a complete checklist. Catalog art is served from local disk, so
  // this costs no third-party requests.
  return `<div class="card${slot.owned ? '' : ' missing'}" data-card="${esc(slot.card_id)}">
    <div class="art">
      ${art
        ? `<img src="${esc(art)}" alt="${esc(slot.label)}" loading="lazy">`
        : placeholder(slot.number, slot.official_set_id)}
      ${complete ? '<span class="badge own">✓</span>' : ''}
      ${slot.owned && !complete
        ? `<span class="badge partial">${slot.quantity}/${slot.target}</span>` : ''}
      ${complete && slot.quantity > 1 ? `<span class="badge qty">×${slot.quantity}</span>` : ''}
    </div>
    <div class="label">
      <span class="nm">${esc(slot.label || '—')}</span>
      <span class="no">#${esc(slot.number || '?')}</span>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ collection */
async function collection(r) {
  const f = {
    set: r.params.get('set') || '',
    condition: r.params.get('condition') || '',
    variant: r.params.get('variant') || '',
    language: r.params.get('language') || '',
    rarity: r.params.get('rarity') || '',
    q: r.params.get('q') || '',
    rating: r.params.get('rating') || '',
    rating_min: r.params.get('rating_min') || '',
    type: r.params.get('type') || '',
    edition: r.params.get('edition') || '',
    min_quantity: r.params.get('min_quantity') || '',
    sort: r.params.get('sort') || 'set',
    page_size: 240,
  };
  // Owned is the default: the inventory is what you reach for most often, and
  // All pulls every slot in the personal sets.
  const showAll = r.params.get('show_all') === '1';
  if (showAll) f.show_all = '1';
  const [res, setList] = await Promise.all([api.collection(f), api.sets()]);
  const t = res.totals;

  const sel = (id, label, options, cur) => `
    <select id="${id}"><option value="">${label}</option>${options.map((o) =>
      `<option value="${esc(o.key)}"${o.key === cur ? ' selected' : ''}>${esc(o.label)}</option>`
    ).join('')}</select>`;

  view().innerHTML = `
    <h1>Cartas</h1>
    <p class="sub">${showAll
      ? `${t.owned_slots ?? 0} / ${t.slots ?? 0} cartas conseguidas · ${
          t.physical_cards} físicas`
      : `${t.unique_cards} cartas diferentes · ${t.physical_cards} cartas físicas · ${
          res.total} registros`}</p>

    <div class="mode-toggle">
      <span class="chip${showAll ? '' : ' on'}" data-mode="owned">En colección</span>
      <span class="chip${showAll ? ' on' : ''}" data-mode="all">Todas las del set</span>
    </div>

    <div class="toolbar">
      <input id="f-q" type="search" placeholder="Buscar…" value="${esc(f.q)}">
      ${sel('f-set', 'Todos los sets', setList.data.map((s) => ({ key: s.id, label: s.name })), f.set)}
      ${sel('f-condition', 'Condición', META.conditions, f.condition)}
      ${sel('f-variant', 'Variante', META.variants, f.variant)}
      ${sel('f-language', 'Idioma', META.languages, f.language)}
      ${sel('f-rarity', 'Rareza', META.rarities.map((x) => ({ key: x, label: x })), f.rarity)}
      ${sel('f-rating', 'Hall of Fame',
        [{ key: '0', label: 'Sin rating' }].concat(META.ratings.filter((x) => x.value > 0)
          .map((x) => ({ key: String(x.value), label: `★ ${x.value}` }))), f.rating)}
      ${sel('f-type', 'Tipo', META.types.map((t) => ({ key: t, label: t })), f.type)}
      ${sel('f-edition', 'Edición', META.editions, f.edition)}
      ${sel('f-min_quantity', 'Cantidad',
        [1, 2, 3, 4, 5].map((n) => ({ key: String(n), label: `${n} o más` })), f.min_quantity)}
      ${sel('f-sort', '', [
        { key: 'set', label: 'Por set' }, { key: 'name', label: 'Por nombre' },
        { key: 'number', label: 'Por número' }, { key: 'rarity', label: 'Por rareza' },
        { key: 'quantity', label: 'Por cantidad' }, { key: 'rating', label: 'Por Hall of Fame' },
        { key: 'recent', label: 'Más recientes' },
      ], f.sort)}
      <span class="spacer">${res.data.length} de ${res.total}</span>
    </div>

    <div class="mode-toggle" style="margin:-4px 0 16px">
      ${[['', 'Todas'], ['1', 'En Hall of Fame']]
        .map(([v, label]) => `<span class="chip${f.rating_min === v ? ' on' : ''}"
           data-qmin="${v}">${label}</span>`).join('')}
    </div>

    ${res.data.length
      ? `<div class="card-grid">${res.data.map(itemHtml).join('')}</div>`
      : '<div class="empty">No hay cartas con estos filtros.</div>'}`;

  const apply = (overrides = {}) => {
    const p = new URLSearchParams();
    for (const k of ['q', 'set', 'condition', 'variant', 'language', 'rarity',
                     'rating', 'type', 'edition', 'min_quantity', 'sort']) {
      const v = view().querySelector(`#f-${k}`).value;
      if (v) p.set(k, v);
    }
    if (f.rating_min && !('rating_min' in overrides)) p.set('rating_min', f.rating_min);
    if (showAll && !('show_all' in overrides)) p.set('show_all', '1');
    for (const [k, v] of Object.entries(overrides)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    location.hash = `#/cartas?${p}`;
  };
  view().querySelectorAll('[data-mode]').forEach((chip) => {
    chip.onclick = () => apply({ show_all: chip.dataset.mode === 'all' ? '1' : '' });
  });
  view().querySelectorAll('[data-qmin]').forEach((chip) => {
    chip.onclick = () => {
      // rating_min=1 is "has any rank at all", since 0 means unranked.
      // Clearing the exact-rating select avoids the two filters fighting.
      view().querySelector('#f-rating').value = '';
      apply({ rating_min: chip.dataset.qmin, rating: '' });
    };
  });
  view().querySelectorAll('.toolbar select').forEach((s) => { s.onchange = apply; });
  const q = view().querySelector('#f-q');
  q.onchange = apply;
  q.onkeydown = (e) => { if (e.key === 'Enter') apply(); };
  wireCardClicks();
}

function itemHtml(i) {
  /* Prefer the user's own photo, then the catalog image (spec §4/§6).
     In "All" mode an unowned slot has no physical copy, so it renders as the
     grey hatched placeholder rather than art the user does not have. */
  const owned = i.owned !== false;
  // display_photo is the best-conditioned copy of this card across every row,
  // so a Damaged scan never stands in for a Near Mint one you also own.
  const shown = i.display_photo || i.photos?.find((p) => p.is_primary) || i.photos?.[0];
  const src = owned ? (shown ? photoUrl(shown) : cardArt(i)) : cardArt(i);
  const v = i.value || {};
  return `<div class="card${owned ? '' : ' missing'}" data-card="${esc(i.card_id)}">
    <div class="art">
      ${src ? `<img src="${esc(src)}" alt="${esc(i.name || i.label)}" loading="lazy">`
            : placeholder(i.number, i.official_set_id)}
      ${owned && i.quantity > 1 ? `<span class="badge qty">×${i.quantity}</span>` : ''}
      ${owned && i.rating ? `<span class="badge hof-badge${i.rating < 7 ? ' fav' : ''}">★${i.rating}</span>` : ''}
      ${owned && v.total != null ? `<span class="badge val">${esc(eur(v.total))}</span>` : ''}
    </div>
    <div class="label">
      <span class="nm">${esc(i.name || i.label || '—')}</span>
      <span class="no">#${esc(i.number)}${owned && i.condition ? ` · ${esc(i.condition)}` : ''}</span>
    </div>
  </div>`;
}

/* ---------------------------------------------------------- mantenimiento */
async function mantenimiento() {
  const [job, mods] = await Promise.all([api.jobStatus(), api.modifiers()]);

  view().innerHTML = `
    <h1>Mantenimiento</h1>
    <p class="sub">Tareas que hablan con fuentes externas y tardan minutos.</p>

    <div class="stat-grid">
      <div class="stat">
        <div class="k">Actualizar precios</div>
        <div class="note">Vuelve a consultar el precio de cada impresión que tenés.
          Los precios manuales no se tocan.</div>
        <div class="btn-row"><button class="btn primary" id="do-prices">Actualizar precios ahora</button></div>
      </div>
      <div class="stat">
        <div class="k">Actualizar base de datos</div>
        <div class="note">Equivale a <code>flask bootstrap</code>: esquema, sets
          incompletos, sets personales e impresiones. Se puede repetir sin riesgo.</div>
        <div class="btn-row"><button class="btn" id="do-rebuild">Actualizar base de datos</button></div>
      </div>
    </div>

    <h2>Objetivos por lote</h2>
    <p class="sub">Cuántas copias querés de cada carta, desde un CSV.
      Descargá el actual, editá la columna y volvé a subirlo.</p>
    <div class="stat">
      <div class="btn-row" style="flex-wrap:wrap;gap:8px;align-items:center">
        <a class="btn" id="dl-targets" download>Descargar CSV actual</a>
        <label class="btn primary" for="up-targets" style="cursor:pointer">Subir CSV</label>
        <input type="file" id="up-targets" accept=".csv,text/csv" hidden>
      </div>
      <div class="note">Columnas: <code>card_id</code>, <code>card_name</code>
        (referencia), <code>target_quantity</code>. El objetivo es de la carta, así
        que vale en todos los sets donde aparezca.</div>
      <div id="targets-result"></div>
    </div>

    <h2>Consultas a la API</h2>
    <p class="sub">Las últimas 24 horas, moviéndose contigo — no se reinicia a
      medianoche, porque no sabemos a qué hora se reinicia la del plan.</p>
    <div id="budget-state"></div>

    <h2>Estado</h2>
    <div id="job-state" class="missing-list"></div>

    <h2>Multiplicadores de precio</h2>
    <p class="sub">El precio de una impresión se ajusta por estos factores.</p>
    <div class="modifier-grid">${Object.entries(mods).map(([kind, rows]) => `
      <div class="stat">
        <div class="k">${esc(kind)}</div>
        ${Object.entries(rows).map(([key, value]) => `
          <div class="form-row" style="align-items:center;gap:8px;margin:6px 0">
            <span style="flex:1">${esc(key)}</span>
            <input type="number" step="0.05" min="0.05" value="${value}"
                   data-kind="${esc(kind)}" data-key="${esc(key)}"
                   style="width:90px">
          </div>`).join('')}
      </div>`).join('')}</div>`;

  renderJob(job);
  renderBudgets(job.budgets);
  view().querySelector('#do-prices').onclick = () => startJob(api.refreshAsync);
  view().querySelector('#do-rebuild').onclick = () => {
    if (confirm('Vuelve a importar lo que falte del catálogo. Puede tardar varios minutos. ¿Seguir?')) {
      startJob(api.rebuildDb);
    }
  };
  const dl = view().querySelector('#dl-targets');
  if (dl) dl.href = api.exportTargetsUrl();

  const up = view().querySelector('#up-targets');
  if (up) {
    up.onchange = async () => {
      const file = up.files && up.files[0];
      if (!file) return;
      const box = view().querySelector('#targets-result');
      box.innerHTML = '<div class="note">Procesando…</div>';
      try {
        renderTargetImport(box, await api.importTargets(file));
      } catch (e) {
        box.innerHTML = `<div class="import-bad">${esc(e.message)}</div>`;
      }
      up.value = '';        // same file twice in a row must re-trigger
    };
  }

  view().querySelectorAll('.modifier-grid input').forEach((input) => {
    input.onchange = async () => {
      try {
        await api.setModifier(input.dataset.kind, input.dataset.key, Number(input.value));
        toast(`${input.dataset.key}: ×${input.value}`);
      } catch (e) { toast(e.message, true); }
    };
  });
  if (job.status === 'running') pollJob();
}

/* The summary leads with what changed, because "45 updated" on a file the user
   already applied would be a lie — unchanged rows are counted separately. Every
   rejected row keeps its line number so the spreadsheet is fixed in one pass. */
function renderTargetImport(box, r) {
  const changes = (r.changes || []).map((c) =>
    `<li><code>${esc(c.card_id)}</code> ${c.from} → <strong>${c.to}</strong></li>`).join('');
  const problems = (r.problems || []).map((p) =>
    `<li>línea ${p.line}${p.card_id ? ` · <code>${esc(p.card_id)}</code>` : ''} — ${esc(p.error)}</li>`).join('');

  box.innerHTML = `
    <div class="import-summary ${r.errors ? 'partial' : 'ok'}">
      <strong>${r.updated}</strong> actualizados ·
      ${r.unchanged} sin cambios ·
      <span class="${r.errors ? 'bad' : ''}">${r.errors} con problemas</span>
    </div>
    ${changes ? `<details class="import-detail"><summary>Cambios (${r.updated})</summary>
       <ul>${changes}</ul></details>` : ''}
    ${problems ? `<details class="import-detail" open><summary>Problemas (${r.errors})</summary>
       <ul class="bad">${problems}</ul></details>` : ''}`;
}

/* What is left of a metered allowance.

   Worth a permanent place rather than an error message: the number only
   matters before you press the button, and by the time a run stops halfway it
   is too late to have wanted it. */
function renderBudgets(budgets) {
  const box = view().querySelector('#budget-state');
  if (!box) return;
  if (!budgets || !budgets.length) {
    box.innerHTML = `<div class="empty">Sin fuentes con límite configuradas.</div>`;
    return;
  }
  box.innerHTML = budgets.map((b) => {
    const pct = b.limit ? Math.min(100, Math.round(100 * b.used / b.limit)) : 0;
    const level = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
    return `<div class="stat budget ${level}">
        <div class="k">${esc(b.provider)}</div>
        <div class="budget-num"><strong>${b.remaining}</strong> disponibles</div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="note">${b.used} de ${b.limit} usadas en las últimas
          ${b.window_hours} h. Las más viejas van saliendo solas.</div>
      </div>`;
  }).join('');
}

function renderJob(job) {
  if (job && job.budgets) renderBudgets(job.budgets);
  const box = view().querySelector('#job-state');
  if (!box) return;
  if (!job || job.status === 'idle') {
    box.innerHTML = '<div class="empty">Sin tareas ejecutadas en esta sesión.</div>';
    return;
  }
  const label = { running: 'En curso', done: 'Terminada', failed: 'Falló' }[job.status];
  box.innerHTML = `
    <div class="missing-row">
      <span class="n">${esc(job.name || '')}</span>
      <span>${esc(label)}${job.started_at ? ` · ${esc(job.started_at)}` : ''}</span>
      <span class="r">${job.error
        ? `<span style="color:var(--bad)">${esc(job.error)}</span>`
        : esc(job.result ? JSON.stringify(job.result) : '')}</span>
    </div>`;
}

async function startJob(fn) {
  try {
    renderJob(await fn());
    pollJob();
  } catch (e) { toast(e.message, true); }
}

/* Polled rather than streamed: these finish in minutes, and a socket for two
   buttons would be more moving parts than the job itself. */
function pollJob() {
  clearInterval(window.__jobPoll);
  window.__jobPoll = setInterval(async () => {
    try {
      const job = await api.jobStatus();
      renderJob(job);
      if (job.status !== 'running') {
        clearInterval(window.__jobPoll);
        toast(job.status === 'done' ? 'Tarea terminada' : `Tarea fallida: ${job.error}`,
              job.status !== 'done');
      }
    } catch { clearInterval(window.__jobPoll); }
  }, 3000);
}

/* --------------------------------------------------------------- missing */
async function missing(r) {
  const { data: setList } = await api.sets();
  const setId = r.id || r.params.get('set') || setList[0]?.id;
  const sort = r.params.get('sort') || 'number';
  if (!setId) { view().innerHTML = '<div class="empty">No hay sets.</div>'; return; }

  const [rows, s] = await Promise.all([api.missing(setId, sort), api.set(setId)]);
  const p = s.progress || {};

  view().innerHTML = `
    <h1>Cartas faltantes</h1>
    <p class="sub">${esc(s.name)} · ${
      rows.data.filter((m) => m.missing_entirely).length} de ${p.target} únicas · faltan ${
      rows.data.reduce((a, m) => a + Math.max(0, m.still_needed || 0), 0)} copias</p>

    <div class="toolbar">
      <select id="f-set">${setList.map((x) => `<option value="${esc(x.id)}"${
        x.id === setId ? ' selected' : ''}>${esc(x.name)} (${x.target - x.owned})</option>`).join('')}</select>
      <select id="f-sort">
        <option value="number"${sort === 'number' ? ' selected' : ''}>Por número</option>
        <option value="name"${sort === 'name' ? ' selected' : ''}>Por nombre</option>
        <option value="rarity"${sort === 'rarity' ? ' selected' : ''}>Por rareza</option>
      </select>
      <span class="spacer">Usa esta vista como wishlist</span>
    </div>

    ${rows.data.length ? `<div class="missing-list">${rows.data.map((m) => `
      <div class="missing-row" data-card="${esc(m.card_id)}">
        <span class="n">#${esc(m.number || '?')}</span>
        <span>${esc(m.label || '')}</span>
        ${m.missing_entirely
          ? (m.target > 1 ? `<span class="tag">faltan ${m.still_needed} copias</span>` : '')
          : `<span class="tag">tenés ${m.held} de ${m.target}</span>`}
        <span class="r">${esc(m.rarity || '')}</span>
      </div>`).join('')}</div>`
      : '<div class="empty">🎉 Set completo.</div>'}`;

  const nav = () => { location.hash = `#/missing/${view().querySelector('#f-set').value}?sort=${
    view().querySelector('#f-sort').value}`; };
  view().querySelector('#f-set').onchange = nav;
  view().querySelector('#f-sort').onchange = nav;
  wireCardClicks();
}

/* ----------------------------------------------------------------- glue */
function wireCardClicks() {
  view().querySelectorAll('[data-card]').forEach((n) => {
    n.onclick = () => { if (n.dataset.card) openCard(n.dataset.card); };
  });
}

function wireSearch() {
  const input = document.getElementById('global-search');
  const box = document.getElementById('search-results');
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const res = await api.search(q);
        const owned = new Set(res.collection.map((c) => c.card_id));
        box.innerHTML = res.cards.length ? res.cards.map((c) => `
          <div class="row" data-card="${esc(c.id)}">
            <img src="${esc(cardArt(c))}" alt="" loading="lazy">
            <div><div>${esc(c.name)}</div>
              <div class="meta">${esc(c.set_name)} #${esc(c.number)}${
                owned.has(c.id) ? ' · en colección' : ''}</div></div>
          </div>`).join('') : '<div class="meta" style="padding:10px">Sin resultados</div>';
        box.hidden = false;
        box.querySelectorAll('[data-card]').forEach((n) => {
          n.onclick = () => { box.hidden = true; input.value = ''; openCard(n.dataset.card); };
        });
      } catch (e) { toast(e.message, true); }
    }, 220);
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) box.hidden = true;
  });
}

boot();
