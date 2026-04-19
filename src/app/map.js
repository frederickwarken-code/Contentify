/**
 * Link-Map: d3-Force-Graph, Presets, Zoom, Verknüpfungsmodus.
 * Zustand für Einfärben/Legende (colorMode, hiddenCats) und Filter bleibt in app.js;
 * Zugriff über setMapHooks.
 */
import { columns } from './columns.js';
import { esc, toast } from './lib.js';
import { appSession } from './session.js';
import { MAP_POS_KEY, MAP_PRESETS_KEY } from './storage-keys.js';
import { preserveTableScrollPosition } from './table.js';

let _hooks = {
  getData: () => [],
  getIdeaMode: () => 'show',
  getActiveFilter: () => null,
  setActiveFilter: () => {},
  getActiveFilterColId: () => null,
  setActiveFilterColId: () => {},
  getColorMode: () => '',
  setColorMode: () => {},
  getHiddenCats: () => new Set(),
  render: () => {},
  renderSidebar: () => {},
  isIdea: () => false,
  notifyPeers: () => {},
};

/** Muss vor erster Map-Interaktion aus app.js aufgerufen werden. */
export function setMapHooks(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

// ─────────────────────────────────────────
// LINK MAP
// ─────────────────────────────────────────
let linkModeActive = false;
// Map state
let mapPhysicsEnabled = true;
let _sim = null;
let selectedNodeId = null;
let mapZoom = null;

// ─── Position store ───────────────────────────────────────────────────────────
// nodePos: { [id]: {x, y} } — the ONLY source of truth for node positions
const nodePos = {};

function loadSavedPos() {
  try {
    const raw = JSON.parse(localStorage.getItem(MAP_POS_KEY)||'{}');
    // Strip invalid positions from buggy 0-dimension builds
    const clean = {};
    Object.entries(raw).forEach(([k,v]) => {
      if(v && isFinite(v.x) && isFinite(v.y) && v.x > 20 && v.y > 20) clean[k] = v;
    });
    return clean;
  } catch { return {}; }
}
function persistPos() {
  // Only persist if we have valid canvas dimensions
  const wrap = document.getElementById('mapWrap');
  if(!wrap || wrap.offsetWidth < 100 || wrap.offsetHeight < 100) return;
  localStorage.setItem(MAP_POS_KEY, JSON.stringify(nodePos));
}
// ─── Presets ─────────────────────────────────────────────────────────────────
function loadPresets() {
  try { return JSON.parse(localStorage.getItem(MAP_PRESETS_KEY)||'[]'); } catch { return []; }
}
function savePresetsStore(p) { localStorage.setItem(MAP_PRESETS_KEY, JSON.stringify(p)); }

export function togglePresetPanel() {
  const panel = document.getElementById('presetPanel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) renderPresetList();
}

function renderPresetList() {
  const el = document.getElementById('presetList');
  if (!el) return;
  const presets = loadPresets();
  if (!presets.length) {
    el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-faint);text-align:center">Noch keine Speicherstände</div>';
    return;
  }
  el.innerHTML = presets.map((p, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 4px;border-radius:6px" onmouseenter="this.style.background='var(--surface2)'" onmouseleave="this.style.background=''">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:500;color:var(--text)">${esc(p.name)}</div>
        <div style="font-size:10px;color:var(--text-faint)">${new Date(p.ts).toLocaleDateString('de-DE')} · ${p.count||0} Einträge · ${esc(p.filterLabel||'Alle')}</div>
      </div>
      <button onclick="loadPreset(${i})" style="font-size:11px;padding:3px 8px;background:var(--accent-light);color:var(--accent);border:none;border-radius:5px;cursor:pointer">Laden</button>
      <button onclick="deletePreset(${i})" style="font-size:11px;padding:3px 6px;background:none;color:var(--red);border:none;border-radius:5px;cursor:pointer">🗑</button>
    </div>`).join('');
}

function savePreset() {
  const nameEl = document.getElementById('presetNameInput');
  const name = nameEl?.value.trim();
  if (!name) { toast('Bitte einen Namen eingeben'); return; }
  // Snapshot current positions
  if (_sim) _sim.nodes().forEach(n=>{ if(n.id) nodePos[n.id]={x:n.x,y:n.y}; });
  const presets = loadPresets();
  const activeFilter = _hooks.getActiveFilter();
  const filterLabel = activeFilter?.values?.size > 0 ? `${activeFilter.colId}:[${[...activeFilter.values].join(',')}]` : 'Alle';
  presets.unshift({
    name, ts: Date.now(),
    count: Object.keys(nodePos).length,
    filterLabel,
    colorMode: _hooks.getColorMode(),
    activeFilter: activeFilter ? {...activeFilter, values: [...(activeFilter.values||[])]} : null,
    activeFilterColId: _hooks.getActiveFilterColId(),
    positions: {...nodePos},
  });
  savePresetsStore(presets);
  if(nameEl) nameEl.value = '';
  renderPresetList();
  toast(`💾 "${name}" gespeichert`);
}

export function loadPreset(i) {
  const preset = loadPresets()[i];
  if (!preset) return;
  // Restore positions
  Object.keys(nodePos).forEach(k=>delete nodePos[k]);
  Object.assign(nodePos, preset.positions||{});
  persistPos();
  // Restore filters
  if (preset.colorMode) _hooks.setColorMode(preset.colorMode);
  if (preset.activeFilterColId) _hooks.setActiveFilterColId(preset.activeFilterColId);
  // Restore activeFilter — convert values array back to Set
  if (preset.activeFilter) {
    _hooks.setActiveFilter({...preset.activeFilter, values: new Set(preset.activeFilter.values||[])});
  } else { _hooks.setActiveFilter(null); }
  togglePresetPanel();
  _hooks.renderSidebar();
  renderMap(); // full rebuild with correct colorMode/filter
  toast(`✅ "${preset.name}" geladen`);
}

export function deletePreset(i) {
  const presets = loadPresets();
  const name = presets[i]?.name;
  presets.splice(i, 1);
  savePresetsStore(presets);
  renderPresetList();
  toast(`🗑 "${name}" gelöscht`);
}

// ─── Physics toggle ──────────────────────────────────────────────────────────
export function toggleMapPhysics() {
  mapPhysicsEnabled = !mapPhysicsEnabled;
  const track = document.getElementById('physicsTrack');
  const thumb = document.getElementById('physicsThumb');
  if(track) track.style.background = mapPhysicsEnabled ? 'var(--accent)' : 'var(--border-mid)';
  if(thumb) thumb.style.left = mapPhysicsEnabled ? '12px' : '2px';
  toast(mapPhysicsEnabled ? '▶ Physics aktiv' : '⏸ Physics aus');
}

// ─── Undo ────────────────────────────────────────────────────────────────────
const undoStack = [];
function pushUndo(action) { undoStack.push(action); if(undoStack.length>30) undoStack.shift(); }
export async function undoMapAction() {
  const action = undoStack.pop();
  if(!action) { toast('Nichts rückgängig zu machen'); return; }
  if(action.type==='move') {
    nodePos[action.id] = {x:action.prevX, y:action.prevY};
    persistPos();
    renderMap();
    toast('↩ Position wiederhergestellt');
  } else if(action.type==='link') {
    const src = _hooks.getData().find(d=>d.id===action.sourceId);
    if(!src) return;
    const newLinks = (src.internalLinks||[]).filter(id=>id!==action.targetId);
    const {error} = await appSession.sb.from('content_items').update({internal_links:newLinks}).eq('id',action.sourceId);
    if(!error) {
      toast('↩ Verlinkung entfernt');
      _hooks.notifyPeers();
    }
  }
}

// ─── Link drag mode ───────────────────────────────────────────────────────────
let _linkDragSource = null;

export function toggleLinkMode() {
  linkModeActive = !linkModeActive;
  const btn = document.getElementById('linkModeBtn');
  if(btn) {
    btn.style.background = linkModeActive ? 'var(--teal)' : '';
    btn.style.color = linkModeActive ? '#fff' : '';
  }
  const wrap = document.getElementById('mapWrap');
  if(wrap) wrap.style.cursor = linkModeActive ? 'crosshair' : 'default';
  toast(linkModeActive ? '🔗 Zieh von Kreis zu Kreis zum Verknüpfen' : 'Verknüpfungs-Modus aus');
}

async function createLinkBetween(sourceId, targetId) {
  const data = _hooks.getData();
  const source = data.find(d=>d.id===sourceId);
  const target = data.find(d=>d.id===targetId);
  if (!source||!target) return;
  if ((source.internalLinks||[]).includes(targetId)) { toast('Bereits verlinkt'); return; }
  const newLinks = [...(source.internalLinks||[]), targetId];
  preserveTableScrollPosition();
  const {error} = await appSession.sb.from('content_items').update({internal_links:newLinks}).eq('id',sourceId);
  if(error) { toast('Fehler: '+error.message); return; }
  pushUndo({type:'link', sourceId, targetId});
  toast(`✅ ${source.title.slice(0,20)} → ${target.title.slice(0,20)}`);
  _hooks.notifyPeers();
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
// mapZoom declared at top level (line 539)
export function zoomIn(){ if(mapZoom) d3.select('#mapSvg').transition().duration(250).call(mapZoom.scaleBy,1.4); }
export function zoomOut(){ if(mapZoom) d3.select('#mapSvg').transition().duration(250).call(mapZoom.scaleBy,0.7); }
export function zoomReset(){ if(!mapZoom)return; const w=document.getElementById('mapWrap'); const W=w?w.offsetWidth:900,H=w?w.offsetHeight:600; d3.select('#mapSvg').transition().duration(350).call(mapZoom.transform, d3.zoomIdentity.translate(W/2,H/2).scale(0.9).translate(-W/2,-H/2)); }

// ─── Color helpers ────────────────────────────────────────────────────────────
function getNodeColor(d) {
  const cm = _hooks.getColorMode();
  const col = columns.find(c=>c.id===cm);
  const opt = (col?.options||[]).find(o=>o.label===d[cm]);
  return opt?.color || '#888';
}
function getNodeLabel(d) { return d[_hooks.getColorMode()]||'–'; }

// ─── renderMap ────────────────────────────────────────────────────────────────
export function renderMap() {
  const area = document.getElementById('contentArea');
  const selectCols = columns.filter(c=>c.type==='select');
  let colorMode = _hooks.getColorMode();
  if(!colorMode||!selectCols.find(c=>c.id===colorMode)) {
    colorMode = selectCols[0]?.id||'';
    _hooks.setColorMode(colorMode);
  }
  const colorByOpts = selectCols.map(c=>`<option value="${c.id}" ${colorMode===c.id?'selected':''}>${esc(c.name)}</option>`).join('');

  area.innerHTML = `
    <div id="mapWrap">
      <svg id="mapSvg"></svg>
      <div id="mapTooltip"></div>
      <div id="mapColorBy">
        <label>Einfärben</label>
        <select id="colorBySelect" onchange="colorMode=this.value;hiddenCats=new Set();renderMap()">${colorByOpts}</select>
      </div>
      <div id="mapLegend"><h4>Legende</h4><div id="legendItems"></div></div>
      <div id="mapControls">
        <button onclick="zoomIn()" title="Zoom in">+</button>
        <button onclick="zoomOut()" title="Zoom out">−</button>
        <button id="linkModeBtn" onclick="toggleLinkMode()" title="Verknüpfen" style="font-size:11px">🔗</button>
        <button onclick="undoMapAction()" title="Rückgängig (Strg+Z)" style="font-size:11px">↩</button>
      </div>
      <div id="mapBottomBar">
        <label style="display:flex;align-items:center;gap:5px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px 10px;font-size:11px;color:var(--text-muted);cursor:pointer;box-shadow:var(--shadow)">
          <div id="physicsTrack" onclick="toggleMapPhysics()" style="width:26px;height:14px;border-radius:7px;background:${mapPhysicsEnabled?'var(--accent)':'var(--border-mid)'};position:relative;cursor:pointer;transition:background .2s;flex-shrink:0">
            <div id="physicsThumb" style="position:absolute;top:2px;left:${mapPhysicsEnabled?'12':'2'}px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .2s"></div>
          </div>
          Physics
        </label>
        <button onclick="togglePresetPanel()" style="font-size:11px;padding:4px 10px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--border);color:var(--text-muted);box-shadow:var(--shadow);cursor:pointer">💾 Speicherstände</button>
      </div>
      <div id="presetPanel" style="display:none;position:absolute;bottom:50px;right:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);width:280px;z-index:20">
        <div style="padding:10px 14px 6px;font-size:12px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          Speicherstände
          <button onclick="togglePresetPanel()" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:13px;padding:0">✕</button>
        </div>
        <div id="presetList" style="max-height:220px;overflow-y:auto;padding:6px 8px"></div>
        <div style="padding:8px;border-top:1px solid var(--border)">
          <div style="display:flex;gap:5px">
            <input id="presetNameInput" type="text" placeholder="Name eingeben…" style="flex:1;padding:5px 8px;border:1px solid var(--border-mid);border-radius:var(--radius);font-size:12px;font-family:var(--sans);color:var(--text);background:var(--surface);outline:none">
            <button type="button" id="presetSaveBtn" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius);padding:5px 10px;font-size:12px;cursor:pointer">Speichern</button>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('presetSaveBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void savePreset();
  });
  // Restore link mode button if active
  const lmBtn = document.getElementById('linkModeBtn');
  if(lmBtn&&linkModeActive){ lmBtn.style.background='var(--teal)'; lmBtn.style.color='#fff'; }
  const wrap2 = document.getElementById('mapWrap');
  if(wrap2) wrap2.style.cursor = linkModeActive?'crosshair':'default';
  // Always call buildGraph after DOM settles
  // ResizeObserver handles the case where dimensions aren't ready yet
  const _wrap = document.getElementById('mapWrap');
  if(_wrap) {
    if(_wrap.offsetWidth > 100 && _wrap.offsetHeight > 100) {
      // Dimensions already good — call directly
      buildGraph();
    } else {
      // Wait for dimensions via ResizeObserver
      const _ro = new ResizeObserver((entries, obs) => {
        const entry = entries[0];
        if(entry.contentRect.width > 100 && entry.contentRect.height > 100) {
          obs.disconnect();
          buildGraph();
        }
      });
      _ro.observe(_wrap);
    }
  }
}

// ─── The simulation reference (_sim, selectedNodeId in this module) ─────────
// ─── buildGraph ───────────────────────────────────────────────────────────────
let _buildGraphPending = null;
export function buildGraph() {
  // Stop any running simulation immediately to prevent stale tick handlers
  if(_sim) { _sim.stop(); _sim = null; }
  // Debounce: if called rapidly, only run the last call
  if(_buildGraphPending) clearTimeout(_buildGraphPending);
  _buildGraphPending = setTimeout(_buildGraphNow, 50);
}

function _buildGraphNow() {
  _buildGraphPending = null;
  const wrap = document.getElementById('mapWrap');
  if(!wrap) return;
  const W = wrap.offsetWidth, H = wrap.offsetHeight;
  // Hard stop — never run with bad dimensions (causes stacked nodes)
  if(!W || !H || W < 100 || H < 100) return;
  // Clean stale bad positions from previous buggy builds
  Object.keys(nodePos).forEach(k => {
    const p = nodePos[k];
    if(!p || !isFinite(p.x) || !isFinite(p.y) || p.x < 20 || p.y < 20) delete nodePos[k];
  });

  if(_sim) { _sim.stop(); _sim = null; }

  const data = _hooks.getData();
  const ideaMode = _hooks.getIdeaMode();
  const activeFilter = _hooks.getActiveFilter();
  const colorMode = _hooks.getColorMode();
  const isIdea = _hooks.isIdea;

  const svg = d3.select('#mapSvg').attr('width',W).attr('height',H);
  // Save current zoom transform before rebuild
  const _existingG = document.querySelector('#mapSvg g');
  const _savedTransform = _existingG ? d3.zoomTransform(document.querySelector('#mapSvg')) : null;
  svg.selectAll('*').remove();

  // Arrow markers
  const defs = svg.append('defs');
  // Arrow markers - colors: grey, teal (outgoing), blue (incoming), idea
  ['arr:#bbb','arr-idea:#f0b429','arr-pot:#f0b429','arr-accent:var(--accent-mid)','arr-blue:var(--blue)'].forEach(s=>{
    const [id,fill]=s.split(':');
    defs.append('marker').attr('id',id).attr('viewBox','0 -4 8 8').attr('refX',8).attr('refY',0)
      .attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
      .attr('markerUnits','strokeWidth')
      .append('path').attr('d','M0,-4L8,0L0,4').attr('fill',fill);
  });

  const g = svg.append('g');

  // ── Filter data ──
  const mapData = data.filter(d=>{
    if(ideaMode==='hide'&&isIdea(d)) return false;
    if(ideaMode==='only'&&!isIdea(d)) return false;
    if(activeFilter && activeFilter.values?.size > 0){
      const raw = d[activeFilter.colId];
      const vals = Array.isArray(raw) ? raw : [String(raw||'')];
      if(!vals.some(v => activeFilter.values.has(String(v)))) return false;
    }
    return true;
  });
  const idSet = new Set(mapData.map(d=>d.id));

  // ── Load saved positions — restore into simulation nodes ──
  const saved = loadSavedPos();
  // Merge saved into nodePos
  Object.keys(saved).forEach(k=>{ if(!nodePos[k]) nodePos[k]=saved[k]; });

  // ── Build nodes with positions ──
  const hasPositions = mapData.some(d=>nodePos[d.id]);
  const nodes = mapData.map((d,i)=>{
    const pos = nodePos[d.id];
    // Only use saved position if it looks valid (not 0,0 and within reasonable bounds)
    const posValid = pos && pos.x > 10 && pos.y > 10 && pos.x < W*3 && pos.y < H*3;
    const angle = (i/mapData.length)*2*Math.PI;
    const spread = Math.min(W,H)*0.38;
    return {
      ...d,
      x: posValid ? pos.x : (W/2 + Math.cos(angle)*spread*(0.6+Math.random()*0.4)),
      y: posValid ? pos.y : (H/2 + Math.sin(angle)*spread*(0.6+Math.random()*0.4)),
    };
  });

  // ── Build edges ──
  const seen = new Set(), edges = [], ideaEdges = [], potEdges = [];
  const ideaNodeIds = new Set(nodes.filter(n=>isIdea(n)).map(n=>n.id));
  mapData.forEach(d=>{
    (d.internalLinks||[]).forEach(tid=>{
      if(!idSet.has(tid)) return;
      const k = [d.id,tid].sort().join('|');
      if(seen.has(k)) return; seen.add(k);
      const isIdeaEdge = ideaNodeIds.has(d.id)||ideaNodeIds.has(tid);
      (isIdeaEdge?ideaEdges:edges).push({source:d.id,target:tid});
    });
    if(isIdea(d)){
      (d.potentialLinks||[]).forEach(tid=>{
        if(!idSet.has(tid)) return;
        const k=[d.id,tid].sort().join('|pot');
        if(seen.has(k)) return; seen.add(k);
        potEdges.push({source:d.id,target:tid});
      });
    }
  });
  const allEdges = [...edges,...ideaEdges];

  // ── Degree ──
  const deg = {};
  nodes.forEach(n=>deg[n.id]=0);
  allEdges.forEach(e=>{deg[e.source]=(deg[e.source]||0)+1;deg[e.target]=(deg[e.target]||0)+1;});
  const nr = d => 8 + (deg[d.id]||0)*2.2;

  // ── Adjacency (for highlight + physics) ──
  const adj = {};
  allEdges.forEach(e=>{
    const s=e.source.id||e.source, t=e.target.id||e.target;
    if(!adj[s]) adj[s]=new Set(); if(!adj[t]) adj[t]=new Set();
    adj[s].add(t); adj[t].add(s);
  });

  // ── Category cluster centers (for initial layout only) ──
  const cats=[...new Set(nodes.map(d=>d[colorMode]||'–'))];
  const catCenters={};
  cats.forEach((cat,i)=>{
    const angle=(i/cats.length)*2*Math.PI-Math.PI/2;
    catCenters[cat]={x:W/2+Math.cos(angle)*Math.min(W,H)*0.32,y:H/2+Math.sin(angle)*Math.min(W,H)*0.32};
  });

  // ── Simulation ──
  // All nodes with saved positions get fx/fy pinned immediately
  // Unsaved nodes float freely and settle via forces
  nodes.forEach(n=>{
    if(nodePos[n.id]){ n.fx=nodePos[n.id].x; n.fy=nodePos[n.id].y; }
  });

  _sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(allEdges).id(d=>d.id).distance(200).strength(0.03))
    .force('charge', d3.forceManyBody().strength(d=>-300-(deg[d.id]||0)*30))
    .force('center', d3.forceCenter(W/2,H/2).strength(hasPositions?0.005:0.04))
    .force('collide', d3.forceCollide().radius(d=>nr(d)+30).strength(0.8))
    .force('clusterX', d3.forceX(d=>{
      const cc=catCenters[d[colorMode]||'–'];
      return (deg[d.id]||0)>4?W/2:(cc?.x??W/2);
    }).strength(hasPositions?0:0.10))
    .force('clusterY', d3.forceY(d=>{
      const cc=catCenters[d[colorMode]||'–'];
      return (deg[d.id]||0)>4?H/2:(cc?.y??H/2);
    }).strength(hasPositions?0:0.10));

  // Stop early if all nodes are pinned (no need to simulate)
  if(nodes.every(n=>n.fx!=null)) { _sim.stop(); }

  // ── Render edges ──
  const potLinkSel = g.append('g').selectAll('line').data(potEdges).join('line')
    .attr('stroke','#f0b429').attr('stroke-opacity',0.5).attr('stroke-width',1.5)
    .attr('stroke-dasharray','5,4').attr('marker-end','url(#arr-pot)');

  const ideaLinkSel = g.append('g').selectAll('line').data(ideaEdges).join('line')
    .attr('stroke','#f0b429').attr('stroke-opacity',0.55).attr('stroke-width',1.5)
    .attr('stroke-dasharray','5,4').attr('marker-end','url(#arr-idea)');

  const linkSel = g.append('g').selectAll('line').data(edges).join('line')
    .attr('stroke','#bbb').attr('stroke-opacity',0.4).attr('stroke-width',1.3)
    .attr('marker-end','url(#arr)');

  // Drag line for link mode
  const dragLine = g.append('line')
    .attr('stroke','var(--teal-light)').attr('stroke-width',2).attr('stroke-dasharray','5,4')
    .attr('opacity',0).attr('marker-end','url(#arr)');

  // ── Render nodes ──
  const pcol = columns.find(c=>c.id==='phase');
  const nodeG = g.append('g').selectAll('g').data(nodes).join('g')
    .style('cursor','pointer')
    .on('mousedown', function(){ d3.select(this).raise(); })
    .on('click',(e,d)=>{
      e.stopPropagation();
      if(selectedNodeId===d.id){ selectedNodeId=null; applyHighlight(null,linkSel,ideaLinkSel,nodeG,adj); }
      else { selectedNodeId=d.id; applyHighlight(d.id,linkSel,ideaLinkSel,nodeG,adj); }
    })
    .on('contextmenu',(e,d)=>{
      e.preventDefault(); e.stopPropagation();
      showStaticTT(e,d,deg,linkSel,nodeG,adj);
    })
    .on('dblclick',(e)=>{ e.stopPropagation(); e.preventDefault(); })
    .call(d3.drag()
      .on('start',(e,d)=>{
        if(linkModeActive){
          _linkDragSource=d;
          dragLine.attr('x1',d.x).attr('y1',d.y).attr('x2',d.x).attr('y2',d.y).attr('opacity',1);
          return;
        }
        // Save undo + original positions of ALL nodes before drag
        pushUndo({type:'move',id:d.id,prevX:nodePos[d.id]?.x??d.x,prevY:nodePos[d.id]?.y??d.y});
        d._dragStartX = d.x;
        d._dragStartY = d.y;
        nodes.forEach(n=>{ n._origX=n.x; n._origY=n.y; });
        if(d._returnAnim){ cancelAnimationFrame(d._returnAnim); d._returnAnim=null; }
      })
      .on('drag',(e,d)=>{
        if(linkModeActive){
          if(_linkDragSource) dragLine.attr('x1',_linkDragSource.x).attr('y1',_linkDragSource.y).attr('x2',e.x).attr('y2',e.y);
          return;
        }
        // Move dragged node
        const ddx = e.x - (d._dragStartX??d.x);
        const ddy = e.y - (d._dragStartY??d.y);
        d.x=e.x; d.y=e.y; d.fx=e.x; d.fy=e.y;

        if(mapPhysicsEnabled){
          // Pull connected neighbors softly (15% of drag delta)
          const nbIds = adj[d.id]||new Set();
          nodes.forEach(n=>{
            if(!nbIds.has(n.id)) return;
            n.x = (n._origX??n.x) + ddx*0.15;
            n.y = (n._origY??n.y) + ddy*0.15;
          });
        }
        tick();
      })
      .on('end',(e,d)=>{
        if(linkModeActive&&_linkDragSource){
          dragLine.attr('opacity',0);
          const svgRect=document.getElementById('mapSvg').getBoundingClientRect();
          const gEl=document.getElementById('mapSvg').querySelector('g');
          const tf=gEl?.getCTM();
          const simX=tf?(e.sourceEvent.clientX-svgRect.left-tf.e)/tf.a:(e.sourceEvent.clientX-svgRect.left);
          const simY=tf?(e.sourceEvent.clientY-svgRect.top-tf.f)/tf.d:(e.sourceEvent.clientY-svgRect.top);
          const hit=nodes.find(n=>{
            if(n.id===_linkDragSource.id) return false;
            const dx=n.x-simX, dy=n.y-simY;
            return Math.sqrt(dx*dx+dy*dy)<nr(n)+20;
          });
          if(hit) createLinkBetween(_linkDragSource.id,hit.id);
          else toast('Kein Knoten getroffen');
          _linkDragSource=null;
          return;
        }

        // Pin dragged node at final position
        nodePos[d.id]={x:d.x,y:d.y};
        persistPos();

        if(mapPhysicsEnabled){
          // Float connected neighbors back to their original positions
          const nbIds = adj[d.id]||new Set();
          // Capture their current (slightly displaced) positions as animation start
          const fromPos={}, toPos={};
          nodes.forEach(n=>{
            if(!nbIds.has(n.id)) return;
            fromPos[n.id]={x:n.x, y:n.y};
            toPos[n.id]={x:n._origX??n.x, y:n._origY??n.y};
          });

          const duration = 800;
          const t0 = performance.now();
          function floatBack(ts){
            const t = Math.min(1, (ts-t0)/duration);
            const ease = 1 - Math.pow(1-t, 3); // ease-out cubic = gentle deceleration
            nodes.forEach(n=>{
              if(!nbIds.has(n.id)||!fromPos[n.id]) return;
              n.x = fromPos[n.id].x + (toPos[n.id].x - fromPos[n.id].x)*ease;
              n.y = fromPos[n.id].y + (toPos[n.id].y - fromPos[n.id].y)*ease;
              if(t>=1){ n.x=toPos[n.id].x; n.y=toPos[n.id].y; n.fx=n.x; n.fy=n.y; }
            });
            tick();
            if(t<1) d._returnAnim = requestAnimationFrame(floatBack);
            else d._returnAnim = null;
          }
          d._returnAnim = requestAnimationFrame(floatBack);
        }
      })
    );

  // Disable double-click zoom
  svg.on('dblclick.zoom',null);

  // Idea glow ring
  nodeG.filter(d=>isIdea(d)).append('circle')
    .attr('r',d=>nr(d)+7).attr('fill','rgba(240,180,41,.12)')
    .attr('stroke','#f0b429').attr('stroke-width',1.5).attr('stroke-opacity',0.5)
    .attr('stroke-dasharray','3,3').attr('pointer-events','none');

  // Status ring
  nodeG.append('circle').attr('r',d=>nr(d)+3.5).attr('fill','none')
    .attr('stroke',d=>{ const o=(pcol?.options||[]).find(x=>x.label===d.phase); return o?.color||'#888'; })
    .attr('stroke-width',2.5).attr('stroke-opacity',0.38).attr('pointer-events','none')
    .attr('class','node-ring');

  // Main circle
  nodeG.append('circle').attr('r',nr)
    .attr('fill',d=>_hooks.getHiddenCats().has(getNodeLabel(d))?'#ccc':getNodeColor(d))
    .attr('fill-opacity',d=>_hooks.getHiddenCats().has(getNodeLabel(d))?0.15:0.88)
    .attr('stroke','#fff').attr('stroke-width',2).attr('class','node-circle');

  // Idea emoji
  nodeG.filter(d=>isIdea(d)).append('text')
    .text('💡').attr('text-anchor','middle').attr('dy',d=>-nr(d)-5)
    .attr('font-size',10).attr('pointer-events','none');

  // Label
  nodeG.append('text')
    .text(d=>{ const w=(d.title||'').split(' '); return(w.slice(0,2).join(' ')+(w.length>2?'…':'')).slice(0,18); })
    .attr('text-anchor','middle').attr('dy',d=>nr(d)+13)
    .attr('font-size',9.5).attr('fill','var(--text-muted)').attr('pointer-events','none')
    .attr('class','node-label');

  // ── Tick function ──
  function tick(){
    linkSel.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>{
        const dx=d.target.x-d.source.x,dy=d.target.y-d.source.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
        const r=nr(d.target)+3; // stop just outside target circle
        return d.target.x-dx/dist*r;
      })
      .attr('y2',d=>{
        const dx=d.target.x-d.source.x,dy=d.target.y-d.source.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
        const r=nr(d.target)+3;
        return d.target.y-dy/dist*r;
      });
    ideaLinkSel.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    potLinkSel.attr('x1',d=>{const n=nodes.find(x=>x.id===(d.source.id||d.source));return n?.x||0;})
              .attr('y1',d=>{const n=nodes.find(x=>x.id===(d.source.id||d.source));return n?.y||0;})
              .attr('x2',d=>{const n=nodes.find(x=>x.id===(d.target.id||d.target));return n?.x||0;})
              .attr('y2',d=>{const n=nodes.find(x=>x.id===(d.target.id||d.target));return n?.y||0;});
    nodeG.attr('transform',d=>`translate(${d.x},${d.y})`);
    // Save positions of unpinned nodes as simulation settles
    if(W>100&&H>100) nodes.forEach(n=>{ if(n.x>50&&n.y>50&&n.x<W*2&&n.y<H*2&&!isNaN(n.x)&&!isNaN(n.y)) { if(!nodePos[n.id]||n.fx==null) nodePos[n.id]={x:n.x,y:n.y}; } });
  }

  _sim.on('tick', tick);
  _sim.on('end', ()=>{ persistPos(); });
  // Force initial tick so fixed nodes get their transform set immediately
  tick();

  // ── Zoom ──
  mapZoom = d3.zoom().scaleExtent([0.08,6]).on('zoom',e=>g.attr('transform',e.transform));
  svg.call(mapZoom);
  // Restore previous zoom/pan if map was rebuilt due to filter change
  if(_savedTransform && (_savedTransform.k !== 1 || _savedTransform.x !== 0 || _savedTransform.y !== 0)) {
    svg.call(mapZoom.transform, _savedTransform);
  }
  svg.on('dblclick.zoom',null);
  svg.on('click',()=>{ selectedNodeId=null; applyHighlight(null,linkSel,ideaLinkSel,nodeG,adj); hideTT(); });

  // Re-apply selection if one was active
  if(selectedNodeId) setTimeout(()=>applyHighlight(selectedNodeId,linkSel,ideaLinkSel,nodeG,adj),100);

  buildLegend();
}

// ─── Highlight ────────────────────────────────────────────────────────────────
function applyHighlight(nodeId, linkSel, ideaLinkSel, nodeG, adj) {
  if(!nodeId){
    nodeG.selectAll('.node-circle').attr('fill-opacity',d=>_hooks.getHiddenCats().has(getNodeLabel(d))?0.15:0.88);
    nodeG.selectAll('.node-ring').attr('stroke-opacity',0.38);
    nodeG.selectAll('.node-label').attr('fill','var(--text-muted)').attr('font-weight','normal');
    linkSel.attr('stroke','#bbb').attr('stroke-opacity',0.4).attr('stroke-width',1.3).attr('marker-end','url(#arr)');
    ideaLinkSel.attr('stroke-opacity',0.55);
    return;
  }
  const nb = adj[nodeId]||new Set();
  nodeG.selectAll('.node-circle').attr('fill-opacity',d=>d.id===nodeId?1:nb.has(d.id)?0.9:0.12);
  nodeG.selectAll('.node-ring').attr('stroke-opacity',d=>d.id===nodeId?0.9:nb.has(d.id)?0.6:0.08);
  nodeG.selectAll('.node-label')
    .attr('fill',d=>(d.id===nodeId||nb.has(d.id))?'var(--text)':'var(--text-faint)')
    .attr('font-weight',d=>d.id===nodeId?'600':'normal');
  // Outgoing links (from selected node) = teal/accent, Incoming links (to selected node) = blue
  linkSel.attr('stroke',d=>{
      const s=d.source.id||d.source,t=d.target.id||d.target;
      if(s===nodeId) return'var(--accent-mid)'; // outgoing → teal
      if(t===nodeId) return'var(--blue)';        // incoming → blue
      return'#bbb';
    })
    .attr('stroke-opacity',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?0.9:0.06;})
    .attr('stroke-width',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?2.5:1;})
    .attr('marker-end',d=>{
      const s=d.source.id||d.source,t=d.target.id||d.target;
      if(s===nodeId) return'url(#arr-accent)'; // outgoing → teal arrow
      if(t===nodeId) return'url(#arr-blue)';   // incoming → blue arrow
      return'url(#arr)';
    });
  ideaLinkSel.attr('stroke-opacity',d=>{const s=d.source.id||d.source,t=d.target.id||d.target;return(s===nodeId||t===nodeId)?0.9:0.06;});
}

// ─── Legend ───────────────────────────────────────────────────────────────────
function buildLegend(){
  const el=document.getElementById('legendItems'); if(!el) return; el.innerHTML='';
  const col=columns.find(c=>c.id===_hooks.getColorMode()); if(!col) return;
  (col.options||[]).forEach(opt=>{
    const used=_hooks.getData().some(d=>d[col.id]===opt.label); if(!used) return;
    const div=document.createElement('div');
    div.className='legend-item'+(_hooks.getHiddenCats().has(opt.label)?' muted':'');
    div.onclick=()=>{_hooks.getHiddenCats().has(opt.label)?_hooks.getHiddenCats().delete(opt.label):_hooks.getHiddenCats().add(opt.label);renderMap();};
    div.innerHTML=`<span class="legend-dot" style="background:${opt.color}"></span><span style="color:var(--text-muted)">${esc(opt.label)}</span>`;
    el.appendChild(div);
  });
  const n=document.createElement('div');
  n.style.cssText='font-size:10px;color:var(--text-faint);margin-top:7px;border-top:1px solid var(--border);padding-top:5px';
  n.innerHTML='Rechtsklick = Details · 🔗 = Verknüpfen';
  el.appendChild(n);
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function showStaticTT(event,d,deg,linkSel,nodeG,adj){
  const wrap=document.getElementById('mapWrap'); if(!wrap) return;
  const r=wrap.getBoundingClientRect();
  const tt=document.getElementById('mapTooltip'); if(!tt) return;
  const cm = _hooks.getColorMode();
  const col=columns.find(c=>c.id===cm);
  const colVal=d[cm]||'';
  const colOpt=(col?.options||[]).find(o=>o.label===colVal);
  const linkedTo=(d.internalLinks||[]).map(id=>{const t=_hooks.getData().find(x=>x.id===id);return t?.title||'';}).filter(Boolean);
  tt.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
      <div class="tt-title">${esc(d.title)}</div>
      <button onclick="openDrawer('${d.id}');hideTT()" style="font-size:11px;padding:2px 8px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✏️ Bearbeiten</button>
    </div>
    ${colVal?`<div class="tt-row"><span class="cell-tag" style="background:${colOpt?.color||'#888'}22;color:${colOpt?.color||'#888'}">${esc(colVal)}</span></div>`:''}
    <div class="tt-row">Verbindungen: <span style="color:var(--text)">${deg[d.id]||0}</span></div>
    ${linkedTo.length?`<div class="tt-row">→ ${linkedTo.slice(0,5).map(t=>`<span style="color:var(--text)">${esc(t.slice(0,30))}</span>`).join('<br>→ ')}</div>`:''}
    <div style="font-size:10px;color:var(--text-faint);margin-top:6px;border-top:1px solid var(--border);padding-top:5px">Linksklick außerhalb zum Schließen</div>`;
  let x=event.clientX-r.left+14, y=event.clientY-r.top-10;
  if(x+270>r.width) x=event.clientX-r.left-280;
  if(y+280>r.height) y=Math.max(10,event.clientY-r.top-290);
  tt.style.left=x+'px'; tt.style.top=y+'px'; tt.style.opacity='1';
}
export function hideTT(){ const tt=document.getElementById('mapTooltip'); if(tt) tt.style.opacity='0'; }
function moveTT(){}