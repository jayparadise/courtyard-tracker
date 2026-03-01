import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, CartesianGrid
} from "recharts";

// ─── Config ──────────────────────────────────────────────────────────────────
const CONTRACT       = "0x251be3a17af4892035c37ebf5890f4a4d889dcad";
const RPC_URL        = "https://polygon-mainnet.g.alchemy.com/v2/demo";
const NFT_API        = "https://polygon-mainnet.g.alchemy.com/nft/v3/demo";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FROM_ZERO      = "0x0000000000000000000000000000000000000000000000000000000000000000";
const POLL_MS        = 30_000;
const LOOKBACK_BLOCKS = 400;

const PACKS = [
  { id: "all",              label: "ALL",               price: 50,  sport: null         },
  { id: "pokemon_starter",  label: "Pokémon Starter",   price: 25,  sport: "pokemon"    },
  { id: "pokemon_pro",      label: "Pokémon Pro",       price: 50,  sport: "pokemon"    },
  { id: "pokemon_master",   label: "Pokémon Master",    price: 100, sport: "pokemon"    },
  { id: "pokemon_platinum", label: "Pokémon Platinum",  price: 500, sport: "pokemon"    },
  { id: "basketball_pro",   label: "Basketball Pro",    price: 50,  sport: "basketball" },
  { id: "sports_pro",       label: "Sports Pro",        price: 50,  sport: "sports"     },
  { id: "sports_master",    label: "Sports Master",     price: 100, sport: "sports"     },
  { id: "vintage",          label: "Vintage",           price: 99,  sport: "vintage"    },
];

const TIERS = {
  common:   { label: "COMMON",   color: "#4ade80", glow: "#052e16", range: "$25–$40"    },
  uncommon: { label: "UNCOMMON", color: "#a78bfa", glow: "#2e1065", range: "$40–$50"    },
  rare:     { label: "RARE",     color: "#38bdf8", glow: "#0c4a6e", range: "$50–$100"   },
  epic:     { label: "EPIC",     color: "#f472b6", glow: "#500724", range: "$100–$200"  },
  chase:    { label: "CHASE",    color: "#f59e0b", glow: "#451a03", range: "$200–$1600" },
};

// ─── Blockchain Helpers ───────────────────────────────────────────────────────
async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function getLatestBlock() {
  return parseInt(await rpc("eth_blockNumber", []), 16);
}

async function getMintLogs(fromBlock, toBlock) {
  const logs = await rpc("eth_getLogs", [{
    address:   CONTRACT,
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock:   "0x" + toBlock.toString(16),
    topics:    [TRANSFER_TOPIC, FROM_ZERO],
  }]);
  return (logs || []).map(log => ({
    tokenId:     parseInt(log.topics[3], 16),
    blockNumber: parseInt(log.blockNumber, 16),
    txHash:      log.transactionHash,
  }));
}

async function fetchNFTMeta(tokenId) {
  try {
    const r = await fetch(
      `${NFT_API}/getNFTMetadata?contractAddress=${CONTRACT}&tokenId=${tokenId}`,
      { headers: { accept: "application/json" } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const attrs = {};
    const rawAttrs = d.raw?.metadata?.attributes || d.contract?.openSeaMetadata?.traits || [];
    rawAttrs.forEach(a => {
      attrs[(a.trait_type || a.key || "").toLowerCase()] = a.value;
    });
    return {
      name:  d.name || d.contract?.name || `Card #${tokenId}`,
      image: d.image?.originalUrl || d.image?.thumbnailUrl || null,
      attrs,
    };
  } catch {
    return null;
  }
}

function classifyCard(meta, tokenId) {
  if (!meta) return {
    tokenId, name: `Card #${tokenId}`, tier: "common",
    estimatedValue: 28, sport: "sports", image: null,
    grade: "?", grader: "PSA",
  };

  const { name, image, attrs } = meta;
  const n = name.toLowerCase();

  const grade = parseFloat(
    attrs["psa grade"] || attrs["cgc grade"] || attrs["bgs grade"] ||
    attrs["grade"] || "7"
  );
  const grader = String(
    attrs.grader || attrs.grading_company || "PSA"
  ).toUpperCase();

  let v = 22;
  if      (grade >= 10)  v *= 3.5;
  else if (grade >= 9.5) v *= 2.2;
  else if (grade >= 9)   v *= 1.7;
  else if (grade >= 8)   v *= 1.1;
  else                   v *= 0.65;

  if (n.includes("charizard"))                              v *= 4.5;
  else if (n.includes("pikachu") || n.includes("mewtwo"))   v *= 2.5;
  else if (n.includes("pokemon") || n.includes("pokémon"))  v *= 1.8;

  if (n.includes("1st edition") || n.includes("first edition")) v *= 5;
  if (n.includes("lebron") || n.includes("jordan") || n.includes("kobe")) v *= 4.5;
  if (n.includes("brady") || n.includes("mahomes"))         v *= 3.5;
  if (n.includes("prizm") || n.includes("refractor"))       v *= 2.2;
  if (n.includes("auto") || n.includes("autograph"))        v *= 3;
  if (n.includes("rookie") || n.includes(" rc "))           v *= 1.6;

  v = Math.min(v, 1400);
  const ev = Math.round(v);

  let tier = "common";
  if      (ev >= 200) tier = "chase";
  else if (ev >= 100) tier = "epic";
  else if (ev >= 50)  tier = "rare";
  else if (ev >= 40)  tier = "uncommon";

  const sport =
    n.includes("pokemon") || n.includes("pokémon")   ? "pokemon"
    : n.includes("basketball") || n.includes("nba")   ? "basketball"
    : n.includes("football")   || n.includes("nfl")   ? "football"
    : n.includes("baseball")   || n.includes("mlb")   ? "baseball"
    : "sports";

  return { tokenId, name, image, tier, estimatedValue: ev, sport, grade, grader };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function EVTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const ratio = payload[0].value;
  const color = ratio >= 1.2 ? "#4ade80" : ratio >= 1.0 ? "#a3e635" : "#f87171";
  return (
    <div style={{
      background: "#0e0e0e", border: "1px solid #222", borderRadius: 6,
      padding: "8px 12px", fontSize: 11, fontFamily: "inherit",
    }}>
      <div style={{ color: "#555", marginBottom: 2 }}>{label}</div>
      <div style={{ color, fontSize: 16, fontWeight: 700 }}>{ratio.toFixed(3)}</div>
      <div style={{ color: "#444", fontSize: 10 }}>EV Ratio</div>
    </div>
  );
}

function TierBar({ tier, count, total, avgVal }) {
  const cfg = TIERS[tier];
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        marginBottom: 5, alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            background: cfg.glow, color: cfg.color,
            padding: "1px 7px", borderRadius: 4,
            fontSize: 10, fontWeight: 700, letterSpacing: 1,
          }}>{cfg.label}</span>
          <span style={{ color: "#333", fontSize: 10 }}>{cfg.range}</span>
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 11 }}>
          <span style={{ color: "#444" }}>{count} pulls</span>
          <span style={{ color: cfg.color, fontWeight: 700 }}>{pct.toFixed(1)}%</span>
        </div>
      </div>
      <div style={{ background: "#111", borderRadius: 3, height: 6, overflow: "hidden" }}>
        <div style={{
          width: pct + "%", height: "100%",
          background: cfg.color, borderRadius: 3,
          transition: "width 0.6s ease",
          boxShadow: `0 0 8px ${cfg.color}55`,
        }} />
      </div>
      {avgVal > 0 && (
        <div style={{ color: "#2a2a2a", fontSize: 10, marginTop: 3 }}>
          avg: <span style={{ color: "#444" }}>${avgVal}</span>
        </div>
      )}
    </div>
  );
}

function PullCard({ pull, isNew }) {
  const cfg = TIERS[pull.tier];
  const secs = Math.round((Date.now() - pull.timestamp) / 1000);
  const timeStr = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  const emoji =
    pull.sport === "pokemon"    ? "⚡"
    : pull.sport === "basketball" ? "🏀"
    : pull.sport === "football"   ? "🏈"
    : pull.sport === "baseball"   ? "⚾"
    : "🃏";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px", borderBottom: "1px solid #0f0f0f",
      background: isNew ? `${cfg.glow}66` : "transparent",
      transition: "background 1.5s ease",
    }}>
      <div style={{
        width: 38, height: 52, borderRadius: 4, flexShrink: 0,
        background: pull.image ? "transparent" : "#0d0d0d",
        border: `1px solid ${cfg.color}33`,
        overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {pull.image
          ? <img src={pull.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <span style={{ fontSize: 18 }}>{emoji}</span>
        }
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: "#bbb",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          marginBottom: 4,
        }}>{pull.name}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{
            background: cfg.glow, color: cfg.color,
            padding: "1px 6px", borderRadius: 3,
            fontSize: 9, fontWeight: 700, letterSpacing: 1,
          }}>{cfg.label}</span>
          {pull.grade !== "?" && (
            <span style={{ color: "#333", fontSize: 10 }}>
              {pull.grader} {pull.grade}
            </span>
          )}
        </div>
      </div>

      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ color: cfg.color, fontWeight: 700, fontSize: 13 }}>
          ${pull.estimatedValue}
        </div>
        <div style={{ color: "#2a2a2a", fontSize: 10 }}>{timeStr}</div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [selectedPack, setSelectedPack] = useState("all");
  const [pulls,        setPulls]        = useState([]);
  const [evHistory,    setEvHistory]    = useState([]);
  const [status,       setStatus]       = useState("connecting");
  const [totalMints,   setTotalMints]   = useState(0);
  const [lastUpdated,  setLastUpdated]  = useState(null);
  const [newPullIds,   setNewPullIds]   = useState(new Set());

  const lastBlockRef = useRef(null);
  const pullsRef     = useRef([]);

  const poll = useCallback(async () => {
    try {
      const latest = await getLatestBlock();
      const from   = lastBlockRef.current
        ? lastBlockRef.current + 1
        : latest - LOOKBACK_BLOCKS;

      if (from <= latest) {
        const mints = await getMintLogs(from, latest);
        setTotalMints(t => t + mints.length);

        const toProcess = mints.slice(-6);
        const newCards  = [];
        for (const mint of toProcess) {
          const meta = await fetchNFTMeta(mint.tokenId);
          newCards.push({
            ...classifyCard(meta, mint.tokenId),
            blockNumber: mint.blockNumber,
            txHash:      mint.txHash,
            timestamp:   Date.now(),
          });
        }

        if (newCards.length > 0) {
          pullsRef.current = [...newCards, ...pullsRef.current].slice(0, 150);
          setPulls([...pullsRef.current]);
          setNewPullIds(new Set(newCards.map(c => c.tokenId)));
          setTimeout(() => setNewPullIds(new Set()), 2500);
        }
      }

      lastBlockRef.current = latest;
      setLastUpdated(new Date());
      setStatus("live");

      // EV data point
      if (pullsRef.current.length > 0) {
        const pack     = PACKS.find(p => p.id === selectedPack) || PACKS[0];
        const filtered = pack.sport
          ? pullsRef.current.filter(p => p.sport === pack.sport)
          : pullsRef.current;
        const recent   = filtered.slice(0, 50);
        if (recent.length > 0) {
          const avg   = recent.reduce((s, p) => s + p.estimatedValue, 0) / recent.length;
          const ratio = +(avg / pack.price).toFixed(4);
          const t     = new Date().toLocaleTimeString("en-US", {
            hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
          });
          setEvHistory(h => [...h.slice(-79), { time: t, ratio }]);
        }
      }
    } catch (e) {
      console.warn("Poll error:", e.message);
      setStatus("error");
    }
  }, [selectedPack]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // ── Derived values ──────────────────────────────────────────────────────────
  const pack     = PACKS.find(p => p.id === selectedPack) || PACKS[0];
  const filtered = pack.sport
    ? pulls.filter(p => p.sport === pack.sport)
    : pulls;

  const recent50 = filtered.slice(0, 50);
  const avgVal   = recent50.length
    ? recent50.reduce((s, p) => s + p.estimatedValue, 0) / recent50.length
    : pack.price;
  const evRatio  = +(avgVal / pack.price).toFixed(4);

  const tierCounts = Object.fromEntries(Object.keys(TIERS).map(t => [t, 0]));
  const tierVals   = Object.fromEntries(Object.keys(TIERS).map(t => [t, []]));
  filtered.slice(0, 100).forEach(p => {
    if (tierCounts[p.tier] !== undefined) {
      tierCounts[p.tier]++;
      tierVals[p.tier].push(p.estimatedValue);
    }
  });
  const totalFiltered = filtered.slice(0, 100).length || 1;

  const evColor = evRatio >= 1.3 ? "#4ade80"
    : evRatio >= 1.1 ? "#a3e635"
    : evRatio >= 1.0 ? "#facc15"
    : "#f87171";

  const evLabel = evRatio >= 1.3 ? "GREAT VALUE"
    : evRatio >= 1.1 ? "GOOD VALUE"
    : evRatio >= 1.0 ? "FAIR VALUE"
    : "BELOW EV";

  const timeSince = lastUpdated
    ? Math.round((Date.now() - lastUpdated.getTime()) / 1000) + "s ago"
    : "—";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      background: "#060606",
      minHeight: "100vh",
      color: "#c0c0c0",
    }}>
      <link
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@600;800&display=swap"
        rel="stylesheet"
      />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: "11px 20px", borderBottom: "1px solid #111",
        background: "#070707",
      }}>
        <span style={{
          fontFamily: "'Syne', sans-serif", fontWeight: 800,
          fontSize: 17, color: "#fff", letterSpacing: -0.5,
        }}>
          Pulld
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background:
              status === "live"       ? "#4ade80"
              : status === "error"    ? "#f87171"
              : "#f59e0b",
            display: "inline-block",
            boxShadow: status === "live" ? "0 0 6px #4ade80" : "none",
            animation: status === "live" ? "pulse 2s infinite" : "none",
          }} />
          <span style={{ fontSize: 10, color: "#444", letterSpacing: 1 }}>
            {status === "live"
              ? "LIVE FEED"
              : status === "error"
              ? "ERROR — RETRYING"
              : "CONNECTING..."}
          </span>
        </div>
        <span style={{ fontSize: 10, color: "#222", marginLeft: 2 }}>
          Updated {timeSince}
        </span>
        <div style={{ marginLeft: "auto", fontSize: 10, color: "#222" }}>
          {totalMints} mints · Block #{lastBlockRef.current?.toLocaleString()}
        </div>
      </div>

      {/* ── Pack Tabs ──────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", overflowX: "auto",
        borderBottom: "1px solid #111", padding: "0 12px",
        background: "#080808",
      }}>
        {PACKS.map(p => (
          <button key={p.id} onClick={() => setSelectedPack(p.id)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "10px 14px", fontSize: 11, whiteSpace: "nowrap",
            color: selectedPack === p.id ? "#fff" : "#333",
            borderBottom: selectedPack === p.id
              ? "2px solid #4ade80"
              : "2px solid transparent",
            fontFamily: "inherit", letterSpacing: 0.5,
            transition: "all 0.15s",
          }}>
            {p.label}
            {p.price > 0 && (
              <span style={{
                color: selectedPack === p.id ? "#555" : "#1e1e1e",
                marginLeft: 5, fontSize: 10,
              }}>${p.price}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── EV Banner ──────────────────────────────────────────────────────── */}
      <div style={{
        margin: "14px 16px 0",
        padding: "13px 20px",
        background: evColor + "0b",
        border: `1px solid ${evColor}20`,
        borderRadius: 8,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{
            color: evColor, fontFamily: "'Syne', sans-serif",
            fontWeight: 800, fontSize: 14, letterSpacing: 1,
          }}>{evLabel}</span>
          <span style={{ color: "#2a2a2a", fontSize: 11 }}>
            EV Ratio: {evRatio.toFixed(3)}
          </span>
        </div>
        <div style={{ fontSize: 10, color: "#1e1e1e" }}>
          {filtered.length} pulls tracked
        </div>
      </div>

      {/* ── Stats Cards ────────────────────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
        gap: 10, padding: "12px 16px",
      }}>
        {[
          { label: "PACK PRICE",    value: `$${pack.price}.00`,      sub: pack.label },
          {
            label: "CALIBRATED EV", value: `$${avgVal.toFixed(2)}`,
            sub: `Ratio: ${evRatio.toFixed(3)}`,                      color: evColor,
          },
          {
            label: "AVG PULL VALUE",value: `$${avgVal.toFixed(2)}`,
            sub: `${evRatio >= 1 ? "+" : ""}${((evRatio - 1) * 100).toFixed(1)}% vs price`,
            color: evColor,
          },
          { label: "PULL HISTORY",  value: filtered.length.toString(), sub: "total tracked" },
        ].map(s => (
          <div key={s.label} style={{
            background: "#0a0a0a", border: "1px solid #111",
            borderRadius: 8, padding: "14px 16px",
          }}>
            <div style={{ fontSize: 9, color: "#2a2a2a", letterSpacing: 1.5, marginBottom: 8 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color || "#ddd", marginBottom: 4 }}>
              {s.value}
            </div>
            <div style={{ fontSize: 10, color: "#2a2a2a" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* ── EV Chart ───────────────────────────────────────────────────────── */}
      <div style={{
        margin: "0 16px 12px",
        background: "#090909", border: "1px solid #111",
        borderRadius: 8, padding: "16px 8px 8px",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "0 12px 12px",
        }}>
          <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <span style={{ fontSize: 10, color: "#333", letterSpacing: 1 }}>EV RATIO</span>
            <span style={{ fontSize: 26, fontWeight: 700, color: evColor }}>
              {evRatio.toFixed(3)}
            </span>
            <span style={{ fontSize: 12, color: evColor }}>
              {evRatio >= 1 ? "▲" : "▼"} {Math.abs((evRatio - 1) * 100).toFixed(1)}%
            </span>
          </div>
          <div style={{ fontSize: 10, color: "#1e1e1e" }}>last 80 data points</div>
        </div>

        {evHistory.length > 2 ? (
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={evHistory} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#0f0f0f" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: "#1e1e1e", fontSize: 9 }}
                axisLine={false} tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "#1e1e1e", fontSize: 9 }}
                axisLine={false} tickLine={false}
                domain={["auto", "auto"]}
              />
              <ReferenceLine
                y={1.0} stroke="#1e1e1e" strokeDasharray="4 4"
                label={{ value: "1.0×", fill: "#2a2a2a", fontSize: 9 }}
              />
              <Tooltip content={<EVTooltip />} />
              <Line
                type="monotone" dataKey="ratio"
                stroke={evColor} strokeWidth={1.5}
                dot={false} activeDot={{ r: 3, fill: evColor }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{
            height: 190, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            color: "#1e1e1e", fontSize: 12, gap: 8,
          }}>
            <div style={{ fontSize: 22 }}>📡</div>
            {status === "connecting"
              ? "Connecting to Polygon network..."
              : "Waiting for pull data to build chart..."}
          </div>
        )}
      </div>

      {/* ── Bottom: Feed + Odds ────────────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 360px",
        gap: 10, padding: "0 16px 24px",
      }}>

        {/* Pull Feed */}
        <div style={{
          background: "#090909", border: "1px solid #111",
          borderRadius: 8, overflow: "hidden",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px 16px", borderBottom: "1px solid #0f0f0f",
          }}>
            <span style={{ fontSize: 11, color: "#444", letterSpacing: 1 }}>
              🔥 JUST PULLED
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: "#4ade80", display: "inline-block",
                boxShadow: "0 0 5px #4ade80",
              }} />
              <span style={{ fontSize: 10, color: "#2a2a2a" }}>Live</span>
            </div>
          </div>

          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{
                padding: 48, textAlign: "center",
                color: "#1a1a1a", fontSize: 12, lineHeight: 2,
              }}>
                {status === "connecting" ? (
                  <>
                    <div style={{ fontSize: 24, marginBottom: 12 }}>⛓️</div>
                    <div>Scanning Polygon blockchain…</div>
                    <div style={{ fontSize: 10, marginTop: 6, color: "#111" }}>
                      Block ~{(lastBlockRef.current || 0).toLocaleString()}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 24, marginBottom: 12 }}>🔍</div>
                    <div>No pulls detected yet</div>
                    <div style={{ fontSize: 10, marginTop: 6 }}>
                      Will update automatically
                    </div>
                  </>
                )}
              </div>
            ) : filtered.map((pull, i) => (
              <PullCard
                key={`${pull.tokenId}-${i}`}
                pull={pull}
                isNew={newPullIds.has(pull.tokenId)}
              />
            ))}
          </div>
        </div>

        {/* Calibrated Odds */}
        <div style={{
          background: "#090909", border: "1px solid #111",
          borderRadius: 8, padding: 16,
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between",
            marginBottom: 18, alignItems: "center",
          }}>
            <span style={{ fontSize: 11, color: "#444", letterSpacing: 1 }}>
              CALIBRATED ODDS
            </span>
            <span style={{
              fontSize: 10,
              color: evRatio >= 1 ? "#4ade80" : "#f87171",
            }}>
              {evRatio >= 1 ? "+" : ""}{((evRatio - 1) * 100).toFixed(1)}% profit zone
            </span>
          </div>

          {Object.entries(TIERS).map(([key]) => (
            <TierBar
              key={key}
              tier={key}
              count={tierCounts[key]}
              total={totalFiltered}
              avgVal={
                tierVals[key].length
                  ? Math.round(tierVals[key].reduce((a, b) => a + b, 0) / tierVals[key].length)
                  : 0
              }
            />
          ))}

          {/* Break-even bar */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #111" }}>
            <div style={{
              display: "flex", justifyContent: "space-between",
              marginBottom: 6, fontSize: 10, color: "#2a2a2a",
            }}>
              <span>Loss / Break-even ({(100 / evRatio).toFixed(1)}%)</span>
              <span>Profit (${(avgVal - pack.price).toFixed(2)})</span>
            </div>
            <div style={{
              background: "#111", borderRadius: 4, height: 8,
              overflow: "hidden", display: "flex",
            }}>
              <div style={{
                width: Math.min((1 / evRatio) * 100, 100) + "%",
                background: "linear-gradient(to right, #f87171, #fbbf24)",
                borderRadius: "4px 0 0 4px",
                transition: "width 0.8s ease",
              }} />
              <div style={{
                flex: 1,
                background: "linear-gradient(to right, #4ade80, #22d3ee)",
                borderRadius: "0 4px 4px 0",
              }} />
            </div>
          </div>

          {/* Confidence */}
          <div style={{
            marginTop: 16, padding: 12,
            background: "#070707", borderRadius: 6, border: "1px solid #0f0f0f",
          }}>
            <div style={{
              fontSize: 9, color: "#222", letterSpacing: 1.5, marginBottom: 8,
            }}>DATA CONFIDENCE</div>
            <div style={{
              fontSize: 11,
              color: filtered.length > 30 ? "#4ade80"
                : filtered.length > 10 ? "#facc15"
                : "#f87171",
            }}>
              {filtered.length > 30 ? "HIGH"
                : filtered.length > 10 ? "MEDIUM"
                : "LOW"}
            </div>
            <div style={{ fontSize: 10, color: "#222", marginTop: 4 }}>
              {filtered.length} calibration pulls
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        textAlign: "center", padding: "0 20px 24px",
        fontSize: 10, color: "#161616", lineHeight: 1.8,
      }}>
        Educational and informational purposes only. Not financial advice.
        Pack outcomes are random — this tool tracks statistical trends only.
        <br />
        Data sourced live from Polygon blockchain · Contract {CONTRACT}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.25; }
        }
        ::-webkit-scrollbar       { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #070707; }
        ::-webkit-scrollbar-thumb { background: #181818; border-radius: 2px; }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}
