import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, CartesianGrid, ReferenceArea
} from "recharts";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONTRACT       = "0x251be3a17af4892035c37ebf5890f4a4d889dcad";
const ALCHEMY_KEY    = "AXHCcv10NBX8K1yLN939m";
const ALCHEMY_RPC    = `https://polygon-mainnet.g.alchemy.com/v2/${AXHCcv10NBX8K1yLN939m}`;
const ALCHEMY_NFT    = `https://polygon-mainnet.g.alchemy.com/nft/v3/${AXHCcv10NBX8K1yLN939m}`;
const PUBLIC_RPCS    = ["https://polygon.llamarpc.com","https://polygon-rpc.com"];
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FROM_ZERO      = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TOKEN_URI_SIG  = "0xc87b56dd";
const POLL_MS        = 25_000;
const LOOKBACK       = 600; // ~30 min of Polygon blocks

// ─── RPC ─────────────────────────────────────────────────────────────────────
let activeRpc = ALCHEMY_RPC;

async function rpcCall(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function rpc(method, params) {
  try { return await rpcCall(activeRpc, method, params); } catch {}
  for (const url of PUBLIC_RPCS) {
    try { const r = await rpcCall(url, method, params); activeRpc = url; return r; } catch {}
  }
  throw new Error("All RPCs failed");
}

// ─── TOKEN ID HELPERS (BigInt — safe for 256-bit IDs) ────────────────────────
const topicToId  = topic  => BigInt(topic).toString(10);
const idToAbiHex = id     => BigInt(id).toString(16).padStart(64, "0");

// ─── URI RESOLVER ─────────────────────────────────────────────────────────────
function resolveUri(uri) {
  if (!uri || uri.startsWith("data:")) return null;
  if (uri.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + uri.slice(7);
  if (uri.startsWith("ar://"))   return "https://arweave.net/" + uri.slice(5);
  return uri;
}

// ─── BLOCKCHAIN CALLS ────────────────────────────────────────────────────────
const getLatestBlock = async () => parseInt(await rpc("eth_blockNumber", []), 16);

async function getMintLogs(from, to) {
  const logs = await rpc("eth_getLogs", [{
    address: CONTRACT,
    fromBlock: "0x" + from.toString(16),
    toBlock:   "0x" + to.toString(16),
    topics: [TRANSFER_TOPIC, FROM_ZERO],
  }]);
  return (logs || []).map(l => ({
    tokenId:     topicToId(l.topics[3]),
    blockNumber: parseInt(l.blockNumber, 16),
    txHash:      l.transactionHash,
  }));
}

async function readTokenURI(id) {
  try {
    const raw = await rpc("eth_call", [
      { to: CONTRACT, data: TOKEN_URI_SIG + idToAbiHex(id) }, "latest"
    ]);
    if (!raw || raw === "0x") return null;
    const hex    = raw.slice(2);
    const offset = parseInt(hex.slice(0, 64), 16) * 2;
    const length = parseInt(hex.slice(offset, offset + 64), 16) * 2;
    const strHex = hex.slice(offset + 64, offset + 64 + length);
    let uri = "";
    for (let i = 0; i < strHex.length; i += 2)
      uri += String.fromCharCode(parseInt(strHex.slice(i, i + 2), 16));
    return uri;
  } catch { return null; }
}

// ─── METADATA FETCH ──────────────────────────────────────────────────────────
// Attempts:
//   1. Alchemy NFT API  (fast, returns image + attributes)
//   2. Read tokenURI from contract → fetch IPFS JSON ourselves
// We specifically look for Courtyard's buyback price in attributes:
//   "buyback_price", "fair_market_value", "fmv", "price", "value"
async function fetchCardMeta(id) {
  const VALUE_KEYS = ["buyback_price","fair_market_value","fmv","price","value","card_value","market_value"];

  // ── Attempt 1: Alchemy NFT API ───────────────────────────────────────────
  try {
    const r = await fetch(
      `${ALCHEMY_NFT}/getNFTMetadata?contractAddress=${CONTRACT}&tokenId=${id}`,
      { headers: { accept: "application/json" } }
    );
    if (r.ok) {
      const d = await r.json();
      const rawAttrs = d.raw?.metadata?.attributes || d.contract?.openSeaMetadata?.traits || [];
      const attrs = {};
      rawAttrs.forEach(a => {
        const k = (a.trait_type || a.key || "").toLowerCase().replace(/\s+/g, "_");
        attrs[k] = a.value;
      });

      // Look for buyback / FMV price in attributes
      let buybackPrice = null;
      for (const key of VALUE_KEYS) {
        if (attrs[key] !== undefined) {
          const parsed = parseFloat(String(attrs[key]).replace(/[^0-9.]/g, ""));
          if (!isNaN(parsed) && parsed > 0) { buybackPrice = parsed; break; }
        }
      }

      const name  = d.name || d.raw?.metadata?.name || null;
      const image = d.image?.originalUrl || d.image?.thumbnailUrl || d.raw?.metadata?.image || null;
      if (name) return { name, image: resolveUri(image), attrs, buybackPrice };
    }
  } catch {}

  // ── Attempt 2: tokenURI → IPFS JSON ─────────────────────────────────────
  try {
    const uri = await readTokenURI(id);
    const url = resolveUri(uri);
    if (!url) return null;
    const r2 = await fetch(url);
    if (!r2.ok) return null;
    const meta = await r2.json();
    const attrs = {};
    (meta.attributes || []).forEach(a => {
      const k = (a.trait_type || "").toLowerCase().replace(/\s+/g, "_");
      attrs[k] = a.value;
    });
    let buybackPrice = null;
    for (const key of VALUE_KEYS) {
      if (attrs[key] !== undefined) {
        const parsed = parseFloat(String(attrs[key]).replace(/[^0-9.]/g, ""));
        if (!isNaN(parsed) && parsed > 0) { buybackPrice = parsed; break; }
      }
    }
    // Also check top-level fields
    if (!buybackPrice && meta.price)        buybackPrice = parseFloat(meta.price);
    if (!buybackPrice && meta.buyback_price) buybackPrice = parseFloat(meta.buyback_price);

    return {
      name:  meta.name  || null,
      image: resolveUri(meta.image) || null,
      attrs,
      buybackPrice,
    };
  } catch { return null; }
}

// ─── CARD CLASSIFICATION ─────────────────────────────────────────────────────
// Tier is based on buyback price (the real Courtyard value) when available.
// Falls back to name-based estimation only if no price in metadata.
function estimateValueFromName(name, attrs) {
  if (!name) return 28;
  const n = name.toLowerCase();
  const grade = parseFloat(
    attrs["psa_grade"] || attrs["cgc_grade"] || attrs["bgs_grade"] || attrs["grade"] || "7"
  );
  let v = 25;
  // Grade multiplier
  if      (grade >= 10)  v *= 3.2;
  else if (grade >= 9.5) v *= 2.0;
  else if (grade >= 9)   v *= 1.6;
  else if (grade >= 8)   v *= 1.0;
  else                   v *= 0.6;
  // Player/card multipliers
  if (n.includes("charizard"))                                        v *= 4.2;
  else if (n.includes("pikachu") || n.includes("mewtwo"))             v *= 2.4;
  else if (n.includes("pokemon") || n.includes("pokémon"))            v *= 1.6;
  if (n.includes("1st edition") || n.includes("first edition"))       v *= 4.5;
  if (n.includes("lebron") || n.includes("jordan") || n.includes("kobe")) v *= 4.0;
  if (n.includes("mahomes") || n.includes("brady"))                   v *= 3.0;
  if (n.includes("ohtani") || n.includes("trout"))                    v *= 2.5;
  if (n.includes("prizm") || n.includes("refractor"))                 v *= 2.0;
  if (n.includes("auto") || n.includes("autograph"))                  v *= 2.8;
  if (n.includes("rookie") || n.includes(" rc ") || n.includes("/rc")) v *= 1.5;
  if (n.includes("superfractor") || n.includes("1/1"))                v *= 8.0;
  return Math.min(Math.round(v), 2000);
}

function classifyCard(meta, id) {
  const fallback = { tokenId: id, name: `Token #${id.slice(0,10)}…`, buybackPrice: 28, tier: "common", sport: "sports", image: null, grade: "?", grader: "PSA", estimated: true };
  if (!meta?.name) return fallback;

  const { name, image, attrs, buybackPrice: rawBuyback } = meta;
  const n = name.toLowerCase();

  const grade  = parseFloat(attrs["psa_grade"] || attrs["cgc_grade"] || attrs["bgs_grade"] || attrs["grade"] || "?");
  const grader = String(attrs["grader"] || attrs["grading_company"] || "PSA").toUpperCase();

  // Use metadata buyback price if available; otherwise estimate
  const value     = rawBuyback && rawBuyback > 0 ? rawBuyback : estimateValueFromName(name, attrs);
  const estimated = !(rawBuyback && rawBuyback > 0);

  const tier =
    value >= 300 ? "chase" :
    value >= 100 ? "epic"  :
    value >= 55  ? "rare"  :
    value >= 40  ? "uncommon" : "common";

  const sport =
    n.includes("pokemon") || n.includes("pokémon") ? "pokemon" :
    n.includes("basketball") || n.includes("nba")   ? "basketball" :
    n.includes("football")   || n.includes("nfl")   ? "football" :
    n.includes("baseball")   || n.includes("mlb")   ? "baseball" :
    n.includes("soccer")     || n.includes("futbol")? "soccer" : "sports";

  return { tokenId: id, name, image, buybackPrice: value, tier, sport, grade: isNaN(grade) ? "?" : grade, grader, estimated };
}

// ─── POOL EV MODEL ────────────────────────────────────────────────────────────
// Maintains a sliding window of recent pulls and computes rolling EV.
// As commons deplete, rolling avg rises above pack price → ratio > 1.
// A sharp DROP in EV after a long climb = chase card pulled (pool value fell).
// A sharp RESET to ~1.0 = likely restock event.
function computeEV(recentPulls, packPrice) {
  if (!recentPulls.length) return 1.0;
  const avg = recentPulls.reduce((s, p) => s + p.buybackPrice, 0) / recentPulls.length;
  return +(avg / packPrice).toFixed(4);
}

// Detect restock: EV suddenly drops to near 1.0 after being elevated
function detectRestock(evHistory) {
  if (evHistory.length < 6) return false;
  const recent = evHistory.slice(-3).map(p => p.ratio);
  const before = evHistory.slice(-8, -3).map(p => p.ratio);
  const recentAvg = recent.reduce((a,b)=>a+b,0)/recent.length;
  const beforeAvg = before.reduce((a,b)=>a+b,0)/before.length;
  return beforeAvg > 1.25 && recentAvg < 1.1 && (beforeAvg - recentAvg) > 0.2;
}

// ─── PACK DEFINITIONS ────────────────────────────────────────────────────────
const PACKS = [
  { id: "all",              label: "ALL",               price: 50,  sport: null,         color: "#e5e7eb" },
  { id: "football_starter", label: "Football Starter",  price: 25,  sport: "football",   color: "#60a5fa" },
  { id: "football_pro",     label: "Football Pro",      price: 50,  sport: "football",   color: "#3b82f6" },
  { id: "football_master",  label: "Football Master",   price: 100, sport: "football",   color: "#1d4ed8" },
  { id: "basketball_pro",   label: "Basketball Pro",    price: 50,  sport: "basketball", color: "#f97316" },
  { id: "baseball_pro",     label: "Baseball Pro",      price: 50,  sport: "baseball",   color: "#22c55e" },
  { id: "pokemon_starter",  label: "Pokémon Starter",   price: 25,  sport: "pokemon",    color: "#facc15" },
  { id: "pokemon_pro",      label: "Pokémon Pro",       price: 50,  sport: "pokemon",    color: "#eab308" },
  { id: "pokemon_master",   label: "Pokémon Master",    price: 100, sport: "pokemon",    color: "#ca8a04" },
  { id: "pokemon_platinum", label: "Pokémon Platinum",  price: 500, sport: "pokemon",    color: "#a16207" },
  { id: "sports_pro",       label: "Sports Pro",        price: 50,  sport: "sports",     color: "#a78bfa" },
  { id: "vintage",          label: "Vintage",           price: 99,  sport: "vintage",    color: "#f472b6" },
];

const TIERS = {
  common:   { label: "COMMON",   color: "#6b7280", range: "$0–$40"    },
  uncommon: { label: "UNCOMMON", color: "#4ade80", range: "$40–$55"   },
  rare:     { label: "RARE",     color: "#38bdf8", range: "$55–$100"  },
  epic:     { label: "EPIC",     color: "#a78bfa", range: "$100–$300" },
  chase:    { label: "CHASE",    color: "#f59e0b", range: "$300+"     },
};

// ─── EV SIGNAL LABELS ────────────────────────────────────────────────────────
function evSignal(ratio) {
  if (ratio >= 1.6) return { label: "🔥 STRONG BUY",   color: "#4ade80", desc: "Pool heavily depleted — rare/epic/chase very likely" };
  if (ratio >= 1.35)return { label: "⚡ GREAT VALUE",   color: "#a3e635", desc: "Significant commons gone — above average pull expected" };
  if (ratio >= 1.15)return { label: "✅ GOOD VALUE",    color: "#facc15", desc: "Mild depletion — slightly above pack price expected" };
  if (ratio >= 0.95)return { label: "〜 FAIR VALUE",    color: "#94a3b8", desc: "Fresh or mid-pool — expect close to pack price" };
  return              { label: "📉 BELOW EV",           color: "#f87171", desc: "Unusual — possibly post-restock or high-chase event" };
}

// ─── COMPONENTS ──────────────────────────────────────────────────────────────
function EVTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const { ratio, event } = payload[0].payload;
  const color = ratio >= 1.35 ? "#4ade80" : ratio >= 1.15 ? "#facc15" : ratio >= 0.95 ? "#94a3b8" : "#f87171";
  return (
    <div style={{ background: "#111", border: "1px solid #1f1f1f", borderRadius: 8, padding: "10px 14px", fontSize: 11, fontFamily: "inherit", minWidth: 160 }}>
      <div style={{ color: "#444", marginBottom: 4 }}>{label}</div>
      <div style={{ color, fontSize: 18, fontWeight: 700, marginBottom: 2 }}>{ratio?.toFixed(3)}</div>
      <div style={{ color: "#333", fontSize: 10 }}>EV Ratio</div>
      {event && <div style={{ color: "#f59e0b", fontSize: 10, marginTop: 6 }}>⚡ {event}</div>}
    </div>
  );
}

function TierRow({ tier, count, total, avgVal }) {
  const cfg = TIERS[tier];
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: cfg.color, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{cfg.label}</span>
          <span style={{ color: "#1e1e1e", fontSize: 10 }}>{cfg.range}</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 10 }}>
          {avgVal > 0 && <span style={{ color: "#2a2a2a" }}>avg ${avgVal}</span>}
          <span style={{ color: "#333" }}>{count} pulls</span>
          <span style={{ color: cfg.color, fontWeight: 700, minWidth: 38, textAlign: "right" }}>{pct.toFixed(1)}%</span>
        </div>
      </div>
      <div style={{ background: "#0d0d0d", borderRadius: 3, height: 5, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: cfg.color, borderRadius: 3, transition: "width 0.8s ease", opacity: 0.85 }} />
      </div>
    </div>
  );
}

function PullRow({ pull, isNew }) {
  const cfg   = TIERS[pull.tier];
  const secs  = Math.floor((Date.now() - pull.ts) / 1000);
  const ts    = secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
  const emoji = pull.sport === "pokemon" ? "⚡" : pull.sport === "basketball" ? "🏀" : pull.sport === "football" ? "🏈" : pull.sport === "baseball" ? "⚾" : pull.sport === "soccer" ? "⚽" : "🃏";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 16px", borderBottom: "1px solid #0a0a0a", background: isNew ? "#0f1a0f" : "transparent", transition: "background 2s ease" }}>
      <div style={{ width: 36, height: 50, flexShrink: 0, borderRadius: 4, overflow: "hidden", background: "#0d0d0d", border: `1px solid ${cfg.color}22`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {pull.image
          ? <img src={pull.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => e.target.style.display = "none"} />
          : <span style={{ fontSize: 16 }}>{emoji}</span>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4 }}>{pull.name}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: cfg.color, fontSize: 9, fontWeight: 700, letterSpacing: 1 }}>{cfg.label}</span>
          {pull.grade !== "?" && <span style={{ color: "#2a2a2a", fontSize: 10 }}>{pull.grader} {pull.grade}</span>}
          {pull.estimated && <span style={{ color: "#1a1a1a", fontSize: 9 }}>~est</span>}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ color: cfg.color, fontWeight: 700, fontSize: 13 }}>${pull.buybackPrice}</div>
        <div style={{ color: "#1e1e1e", fontSize: 10 }}>{ts}</div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [selectedPack, setSelectedPack] = useState("all");
  const [pulls,        setPulls]        = useState([]);
  const [evHistory,    setEvHistory]    = useState([]);
  const [status,       setStatus]       = useState("connecting");
  const [statusMsg,    setStatusMsg]    = useState("Scanning blockchain…");
  const [totalMints,   setTotalMints]   = useState(0);
  const [newIds,       setNewIds]       = useState(new Set());
  const [restockEvents,setRestockEvents]= useState([]);

  const blockRef  = useRef(null);
  const pullsRef  = useRef([]);
  const evRef     = useRef([]);

  // ── Polling loop ────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    try {
      const latest = await getLatestBlock();
      const from   = blockRef.current ? blockRef.current + 1 : latest - LOOKBACK;

      if (from <= latest) {
        const mints = await getMintLogs(from, latest);
        setTotalMints(t => t + mints.length);

        // Process up to 5 new mints per tick to stay within rate limits
        const fresh = [];
        for (const mint of mints.slice(-5)) {
          const meta = await fetchCardMeta(mint.tokenId);
          fresh.push({ ...classifyCard(meta, mint.tokenId), ts: Date.now(), txHash: mint.txHash, blockNumber: mint.blockNumber });
        }

        if (fresh.length > 0) {
          pullsRef.current = [...fresh, ...pullsRef.current].slice(0, 200);
          setPulls([...pullsRef.current]);
          setNewIds(new Set(fresh.map(c => c.tokenId)));
          setTimeout(() => setNewIds(new Set()), 3000);
        }
      }

      blockRef.current = latest;
      setStatus("live");
      setStatusMsg("Live · Polygon");

      // ── Compute EV for selected pack ──────────────────────────────────
      const pack     = PACKS.find(p => p.id === selectedPack) || PACKS[0];
      const filtered = pack.sport
        ? pullsRef.current.filter(p => p.sport === pack.sport)
        : pullsRef.current;
      const window50 = filtered.slice(0, 50); // rolling 50-pull window

      if (window50.length > 0) {
        const ratio  = computeEV(window50, pack.price);
        const t      = new Date().toLocaleTimeString("en-US", { hour12: false });
        const newPt  = { time: t, ratio };
        evRef.current = [...evRef.current.slice(-99), newPt];
        setEvHistory([...evRef.current]);

        // Detect restock
        if (detectRestock(evRef.current)) {
          setRestockEvents(prev => [...prev.slice(-4), t]);
        }
      }
    } catch (e) {
      console.error("Poll error:", e.message);
      setStatus("error");
      setStatusMsg("Error — retrying…");
    }
  }, [selectedPack]);

  useEffect(() => { poll(); const id = setInterval(poll, POLL_MS); return () => clearInterval(id); }, [poll]);

  // ── Derived state ────────────────────────────────────────────────────────
  const pack        = PACKS.find(p => p.id === selectedPack) || PACKS[0];
  const filtered    = pack.sport ? pulls.filter(p => p.sport === pack.sport) : pulls;
  const window50    = filtered.slice(0, 50);
  const avgBuyback  = window50.length ? window50.reduce((s,p) => s + p.buybackPrice, 0) / window50.length : pack.price;
  const evRatio     = +(avgBuyback / pack.price).toFixed(3);
  const signal      = evSignal(evRatio);

  // Tier breakdown from last 100 filtered
  const recentN  = filtered.slice(0, 100);
  const tCounts  = Object.fromEntries(Object.keys(TIERS).map(t => [t, 0]));
  const tVals    = Object.fromEntries(Object.keys(TIERS).map(t => [t, []]));
  recentN.forEach(p => { tCounts[p.tier]++; tVals[p.tier].push(p.buybackPrice); });
  const totalN = recentN.length || 1;
  const tAvgs  = Object.fromEntries(Object.keys(TIERS).map(t =>
    [t, tVals[t].length ? Math.round(tVals[t].reduce((a,b)=>a+b,0)/tVals[t].length) : 0]
  ));

  const evColor = signal.color;

  return (
    <div style={{ fontFamily: "'JetBrains Mono','Courier New',monospace", background: "#060606", minHeight: "100vh", color: "#c0c0c0" }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      {/* ── Header ── */}
      <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 20px", borderBottom: "1px solid #111", background: "#070707", position: "sticky", top: 0, zIndex: 10 }}>
        <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 18, color: "#fff", letterSpacing: -0.5 }}>Pulld</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block",
            background: status === "live" ? "#4ade80" : status === "error" ? "#f87171" : "#f59e0b",
            boxShadow: status === "live" ? "0 0 6px #4ade80" : "none",
            animation: status === "live" ? "pulse 2s infinite" : "none" }} />
          <span style={{ fontSize: 10, color: "#333", letterSpacing: 1 }}>{statusMsg.toUpperCase()}</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 10, color: "#1e1e1e" }}>
          <span>{totalMints} mints detected</span>
          <span>Block #{blockRef.current?.toLocaleString()}</span>
        </div>
      </header>

      {/* ── Pack tabs ── */}
      <div style={{ overflowX: "auto", background: "#080808", borderBottom: "1px solid #0e0e0e", display: "flex" }}>
        {PACKS.map(p => (
          <button key={p.id} onClick={() => setSelectedPack(p.id)} style={{
            background: "none", border: "none", cursor: "pointer", padding: "9px 14px",
            fontSize: 10, letterSpacing: 0.5, whiteSpace: "nowrap",
            color: selectedPack === p.id ? p.color : "#2a2a2a",
            borderBottom: `2px solid ${selectedPack === p.id ? p.color : "transparent"}`,
            fontFamily: "inherit", transition: "all 0.15s",
          }}>
            {p.label.toUpperCase()}
            <span style={{ marginLeft: 4, color: selectedPack === p.id ? "#333" : "#1a1a1a" }}>${p.price}</span>
          </button>
        ))}
      </div>

      {/* ── Signal banner ── */}
      <div style={{ margin: "12px 16px 0", padding: "14px 20px", background: evColor + "08", border: `1px solid ${evColor}18`, borderRadius: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ color: evColor, fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 15, letterSpacing: 0.5 }}>{signal.label}</div>
            <div style={{ color: "#2a2a2a", fontSize: 10, marginTop: 3 }}>{signal.desc}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: evColor, fontSize: 28, fontWeight: 700 }}>{evRatio.toFixed(3)}</div>
            <div style={{ color: "#1e1e1e", fontSize: 10 }}>EV RATIO</div>
          </div>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, padding: "10px 16px" }}>
        {[
          { label: "PACK PRICE",    value: `$${pack.price}`,              sub: pack.label.toUpperCase() },
          { label: "AVG BUYBACK",   value: `$${avgBuyback.toFixed(2)}`,   sub: `Last ${window50.length} pulls`, color: evColor },
          { label: "POOL SIGNAL",   value: evRatio >= 1 ? `+${((evRatio-1)*100).toFixed(1)}%` : `${((evRatio-1)*100).toFixed(1)}%`, sub: "vs pack price", color: evColor },
          { label: "PULLS TRACKED", value: filtered.length,               sub: `${recentN.length} in model` },
        ].map(s => (
          <div key={s.label} style={{ background: "#090909", border: "1px solid #0f0f0f", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 8, color: "#1e1e1e", letterSpacing: 1.5, marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color || "#ccc", marginBottom: 3 }}>{s.value}</div>
            <div style={{ fontSize: 9, color: "#1e1e1e" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* ── EV Chart ── */}
      <div style={{ margin: "0 16px 10px", background: "#090909", border: "1px solid #0f0f0f", borderRadius: 8, padding: "14px 4px 8px" }}>
        <div style={{ padding: "0 14px 12px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
            <span style={{ fontSize: 9, color: "#222", letterSpacing: 1.5 }}>ROLLING EV RATIO · POOL DEPLETION</span>
          </div>
          <div style={{ fontSize: 9, color: "#1a1a1a" }}>
            {restockEvents.length > 0 && `⚡ Restock detected ${restockEvents.slice(-1)[0]}`}
          </div>
        </div>
        {evHistory.length > 3 ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={evHistory} margin={{ top: 5, right: 24, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#0d0d0d" vertical={false} />
              <XAxis dataKey="time" tick={{ fill: "#1a1a1a", fontSize: 8 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#1a1a1a", fontSize: 8 }} axisLine={false} tickLine={false} domain={["auto","auto"]} width={32} />
              {/* Break-even line */}
              <ReferenceLine y={1.0}  stroke="#1e1e1e" strokeDasharray="3 4" label={{ value: "1.0", fill: "#252525", fontSize: 8, position: "insideTopLeft" }} />
              {/* Strong buy zone */}
              <ReferenceLine y={1.35} stroke="#4ade8011" strokeDasharray="2 6" />
              <Tooltip content={<EVTooltip />} />
              <Line type="monotone" dataKey="ratio" stroke={evColor} strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: evColor }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 200, display: "flex", flexDirection: "column", gap: 10, alignItems: "center", justifyContent: "center", color: "#1a1a1a", fontSize: 11 }}>
            <span style={{ fontSize: 20 }}>📡</span>
            {status === "connecting" ? "Connecting to Polygon…" : "Gathering pull data for EV model…"}
            <span style={{ fontSize: 9, color: "#111" }}>EV chart builds after first pulls are detected</span>
          </div>
        )}
        {/* Zone legend */}
        <div style={{ display: "flex", gap: 16, padding: "6px 16px 0", justifyContent: "flex-end" }}>
          {[["#f87171","Below EV"],["#94a3b8","Fair"],["#facc15","Good"],["#4ade80","Strong Buy"]].map(([c,l]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 8, height: 2, background: c }} />
              <span style={{ fontSize: 8, color: "#1e1e1e" }}>{l}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Feed + Odds ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 8, padding: "0 16px 24px" }}>

        {/* Pull Feed */}
        <div style={{ background: "#090909", border: "1px solid #0f0f0f", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "11px 16px", borderBottom: "1px solid #0d0d0d", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "#333", letterSpacing: 1.5 }}>🔥 JUST PULLED · LIVE FEED</span>
            <span style={{ fontSize: 9, color: "#1a1a1a" }}>Values = Courtyard buyback (or ~est)</span>
          </div>
          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 48, textAlign: "center", color: "#111", fontSize: 11, lineHeight: 2.2 }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>⛓️</div>
                Scanning Polygon for mint events…<br />
                <span style={{ fontSize: 9, color: "#0d0d0d" }}>Contract: {CONTRACT}</span>
              </div>
            ) : (
              filtered.map((p, i) => <PullRow key={`${p.tokenId}-${i}`} pull={p} isNew={newIds.has(p.tokenId)} />)
            )}
          </div>
        </div>

        {/* Calibrated Odds + Pool Model */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Tier breakdown */}
          <div style={{ background: "#090909", border: "1px solid #0f0f0f", borderRadius: 8, padding: 16, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "#333", letterSpacing: 1.5 }}>OBSERVED TIER MIX</span>
              <span style={{ fontSize: 9, color: "#1a1a1a" }}>Last {recentN.length} pulls</span>
            </div>
            {Object.keys(TIERS).map(key => (
              <TierRow key={key} tier={key} count={tCounts[key]} total={totalN} avgVal={tAvgs[key]} />
            ))}

            {/* Pool depletion explanation */}
            <div style={{ marginTop: 16, padding: 12, background: "#070707", borderRadius: 6, border: "1px solid #0d0d0d" }}>
              <div style={{ fontSize: 9, color: "#222", letterSpacing: 1.5, marginBottom: 8 }}>HOW THE SIGNAL WORKS</div>
              <div style={{ fontSize: 10, color: "#252525", lineHeight: 1.8 }}>
                Courtyard uses a <span style={{ color: "#333" }}>finite card pool</span>. As commons are pulled, the remaining pool shifts toward rares &amp; epics.<br /><br />
                <span style={{ color: "#4ade80" }}>EV rising</span> = commons depleting<br />
                <span style={{ color: "#f59e0b" }}>EV spikes down</span> = chase card pulled<br />
                <span style={{ color: "#94a3b8" }}>EV resets to ~1.0</span> = likely restock
              </div>
            </div>
          </div>

          {/* Data confidence */}
          <div style={{ background: "#090909", border: "1px solid #0f0f0f", borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 9, color: "#222", letterSpacing: 1.5, marginBottom: 10 }}>DATA CONFIDENCE</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <div style={{ flex: 1, background: "#0d0d0d", borderRadius: 3, height: 4 }}>
                <div style={{ width: `${Math.min((window50.length / 50) * 100, 100)}%`, height: "100%", background: evColor, borderRadius: 3, transition: "width 1s" }} />
              </div>
              <span style={{ fontSize: 10, color: evColor, minWidth: 32, textAlign: "right" }}>
                {window50.length < 10 ? "LOW" : window50.length < 30 ? "MED" : "HIGH"}
              </span>
            </div>
            <div style={{ fontSize: 9, color: "#1a1a1a" }}>
              {window50.length}/50 pull window · {window50.filter(p=>!p.estimated).length} with real buyback price
            </div>
            <div style={{ fontSize: 9, color: "#111", marginTop: 6 }}>
              Values marked ~est used name+grade estimation
            </div>
          </div>
        </div>
      </div>

      <div style={{ textAlign: "center", padding: "0 20px 28px", fontSize: 9, color: "#111", lineHeight: 2 }}>
        For informational purposes only. EV tracking reflects observed pool depletion trends, not guaranteed outcomes.<br />
        Buyback prices sourced from Courtyard NFT metadata where available. Data via Polygon blockchain.
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        ::-webkit-scrollbar { width: 3px }
        ::-webkit-scrollbar-track { background: #060606 }
        ::-webkit-scrollbar-thumb { background: #151515; border-radius: 2px }
        * { box-sizing: border-box }
        button:hover { opacity: 0.85 }
      `}</style>
    </div>
  );
}
