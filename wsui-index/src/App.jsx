import { useEffect, useMemo, useState } from 'react';

const PASSWORD_KEY = 'wsui-password';

const themeColors = {
  'AI Compute': '#1f5eff',
  Storage: '#00a676',
  Memory: '#7c3aed',
  'Cloud Infrastructure': '#f59e0b',
  'Semiconductor Manufacturing': '#d64545'
};

export default function App() {
  const [health, setHealth] = useState(null);
  const [password, setPassword] = useState(() => sessionStorage.getItem(PASSWORD_KEY) || '');
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then(setHealth)
      .catch((requestError) => setError(requestError.message));
  }, []);

  useEffect(() => {
    if (!health) {
      return undefined;
    }

    if (health.passwordRequired && !password) {
      setLoading(false);
      return undefined;
    }

    let isMounted = true;
    const load = async () => {
      try {
        setLoading(true);
        const [snapshotData, historyData] = await Promise.all([apiGet('/api/snapshot'), apiGet('/api/history')]);
        if (isMounted) {
          setSnapshot(snapshotData);
          setHistory(historyData);
          setError('');
        }
      } catch (requestError) {
        if (isMounted) {
          setError(requestError.message);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      isMounted = false;
      window.clearInterval(timer);
    };
  }, [health, password]);

  const sortedByTarget = useMemo(() => {
    return [...(snapshot?.holdings || [])].sort((a, b) => b.targetWeight - a.targetWeight);
  }, [snapshot]);

  async function apiGet(path) {
    const response = await fetch(path, {
      headers: password ? { 'x-wsui-password': password } : {}
    });

    if (response.status === 401) {
      sessionStorage.removeItem(PASSWORD_KEY);
      setPassword('');
      throw new Error('Password required');
    }

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    return response.json();
  }

  function handlePasswordSubmit(nextPassword) {
    sessionStorage.setItem(PASSWORD_KEY, nextPassword);
    setPassword(nextPassword);
  }

  if (health?.passwordRequired && !password) {
    return <PasswordGate onSubmit={handlePasswordSubmit} error={error} />;
  }

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div>
          <p className="eyebrow">WSUI</p>
          <h1>Loading West Side Unity Index</h1>
          <p>{error || 'Preparing the latest simulated index snapshot.'}</p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <Header snapshot={snapshot} />

      {snapshot.source.mode !== 'market' && (
        <div className="system-banner">
          Quote mode: {snapshot.source.mode}. Add <code>FINNHUB_API_KEY</code> in <code>.env</code> to sync market quotes.
        </div>
      )}

      {snapshot.source.baselineStatus !== 'configured' && (
        <div className="system-banner muted-banner">
          Launch prices are currently derived from previous close values. Freeze inception prices in <code>data/fund.json</code> after the official start snapshot.
        </div>
      )}

      <section className="hero-band" id="overview">
        <div className="page-shell hero-layout">
          <div className="hero-copy">
            <p className="eyebrow">Internal Simulation · {snapshot.fund.type}</p>
            <h1>{snapshot.fund.ticker}</h1>
            <h2>{snapshot.fund.name}</h2>
            <p className="hero-text">
              A simulated U.S. equity index tracking AI infrastructure across compute, storage, memory,
              cloud, and semiconductor manufacturing.
            </p>
            <div className="hero-actions">
              <a href="#holdings">Holdings</a>
              <a href="#methodology">Methodology</a>
              <a href="#disclaimer">Disclaimer</a>
            </div>
          </div>

          <div className="market-panel">
            <div className="market-topline">
              <span>NAV</span>
              <strong>{formatNav(snapshot.nav)}</strong>
            </div>
            <div className={snapshot.dayChangePercent >= 0 ? 'change positive' : 'change negative'}>
              {formatSigned(snapshot.dayChange)} / {formatPercent(snapshot.dayChangePercent)}
            </div>
            <div className="metric-grid">
              <Metric label="Since Inception" value={formatPercent(snapshot.totalReturnPercent)} tone={snapshot.totalReturnPercent >= 0 ? 'positive' : 'negative'} />
              <Metric label="Benchmark QQQ" value={formatPercent(snapshot.benchmark.totalReturnPercent)} tone={snapshot.benchmark.totalReturnPercent >= 0 ? 'positive' : 'negative'} />
              <Metric label="Inception" value={formatDate(snapshot.fund.inceptionDate)} />
              <Metric label="Holdings" value={String(snapshot.holdings.length)} />
            </div>
            <p className="timestamp">Updated {formatDateTime(snapshot.updatedAt)}</p>
          </div>
        </div>
      </section>

      <section className="band white-band">
        <div className="page-shell stack-layout">
          <div>
            <p className="eyebrow">Target Allocation</p>
            <h2>AI Infrastructure Stack</h2>
          </div>
          <StackBar holdings={sortedByTarget} />
        </div>
      </section>

      <section className="band" id="performance">
        <div className="page-shell two-column">
          <div>
            <p className="eyebrow">Performance</p>
            <h2>WSUI vs QQQ</h2>
            <p className="section-copy">
              WSUI begins at NAV 100.00 and tracks the launch basket after target-weight construction.
            </p>
          </div>
          <LineChart points={history?.points || []} />
        </div>
      </section>

      <section className="band white-band" id="themes">
        <div className="page-shell">
          <div className="section-heading">
            <p className="eyebrow">Themes</p>
            <h2>What WSUI Owns</h2>
          </div>
          <div className="theme-grid">
            {sortedByTarget.map((holding) => (
              <article className="theme-tile" key={holding.symbol}>
                <span style={{ background: themeColors[holding.theme] || '#2f3948' }} />
                <h3>{holding.symbol}</h3>
                <p>{holding.theme}</p>
                <strong>{formatWeight(holding.targetWeight)}</strong>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="band" id="holdings">
        <div className="page-shell">
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">Holdings</p>
              <h2>Current Portfolio</h2>
            </div>
            <span className="pill">{snapshot.source.provider}</span>
          </div>
          <HoldingsTable holdings={snapshot.holdings} />
        </div>
      </section>

      <section className="band white-band" id="methodology">
        <div className="page-shell methodology-grid">
          <div>
            <p className="eyebrow">Methodology</p>
            <h2>Target Weight, Then Drift</h2>
          </div>
          <div className="method-list">
            <MethodItem label="Launch" value={`Initial NAV ${formatNav(snapshot.fund.initialNav)} on ${formatDate(snapshot.fund.inceptionDate)}`} />
            <MethodItem label="Weighting" value={snapshot.fund.methodology.weighting} />
            <MethodItem label="Rebalance" value={snapshot.fund.methodology.rebalanceFrequency} />
            <MethodItem label="Benchmark" value={`${snapshot.benchmark.symbol} · ${snapshot.benchmark.name}`} />
          </div>
        </div>
      </section>

      <footer className="footer" id="disclaimer">
        <div className="page-shell">
          <strong>{snapshot.fund.ticker} · {snapshot.fund.name}</strong>
          <p>{snapshot.fund.disclaimer}</p>
        </div>
      </footer>
    </main>
  );
}

function Header({ snapshot }) {
  return (
    <header className="topbar">
      <a className="brand" href="#overview">
        <span>{snapshot.fund.ticker}</span>
        <strong>{snapshot.fund.name}</strong>
      </a>
      <nav>
        <a href="#performance">Performance</a>
        <a href="#themes">Themes</a>
        <a href="#holdings">Holdings</a>
        <a href="#methodology">Methodology</a>
      </nav>
    </header>
  );
}

function PasswordGate({ onSubmit, error }) {
  const [value, setValue] = useState('');

  return (
    <main className="password-screen">
      <form
        className="password-box"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <p className="eyebrow">WSUI Private View</p>
        <h1>West Side Unity Index</h1>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Group password"
        />
        <button type="submit">Enter</button>
        {error && <p className="form-error">{error}</p>}
      </form>
    </main>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone || ''}>{value}</strong>
    </div>
  );
}

function StackBar({ holdings }) {
  return (
    <div className="stack-visual">
      <div className="stack-bar" aria-label="Target allocation">
        {holdings.map((holding) => (
          <span
            key={holding.symbol}
            style={{
              width: `${holding.targetWeight * 100}%`,
              background: themeColors[holding.theme] || '#2f3948'
            }}
            title={`${holding.symbol} ${formatWeight(holding.targetWeight)}`}
          />
        ))}
      </div>
      <div className="stack-legend">
        {holdings.map((holding) => (
          <div key={holding.symbol}>
            <span style={{ background: themeColors[holding.theme] || '#2f3948' }} />
            <strong>{holding.symbol}</strong>
            <em>{formatWeight(holding.targetWeight)}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineChart({ points }) {
  const cleanPoints = points.filter((point) => Number.isFinite(point.wsui) && Number.isFinite(point.benchmark));
  const values = cleanPoints.flatMap((point) => [point.wsui, point.benchmark]);
  const min = Math.min(...values, 96);
  const max = Math.max(...values, 104);
  const width = 720;
  const height = 260;
  const padding = 28;
  const xStep = cleanPoints.length > 1 ? (width - padding * 2) / (cleanPoints.length - 1) : 0;
  const yFor = (value) => {
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    return height - padding - ratio * (height - padding * 2);
  };
  const lineFor = (key) => cleanPoints
    .map((point, index) => `${padding + index * xStep},${yFor(point[key])}`)
    .join(' ');

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="WSUI and benchmark performance chart">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="axis" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} className="axis" />
        <polyline points={lineFor('benchmark')} className="chart-line benchmark-line" />
        <polyline points={lineFor('wsui')} className="chart-line wsui-line" />
        {cleanPoints.map((point, index) => (
          <circle key={`${point.date}-${index}`} cx={padding + index * xStep} cy={yFor(point.wsui)} r="4" className="wsui-dot" />
        ))}
      </svg>
      <div className="chart-legend">
        <span><i className="wsui-key" /> WSUI</span>
        <span><i className="benchmark-key" /> QQQ</span>
      </div>
    </div>
  );
}

function HoldingsTable({ holdings }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Name</th>
            <th>Theme</th>
            <th>Target</th>
            <th>Current</th>
            <th>Price</th>
            <th>Day</th>
            <th>Contribution</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding) => (
            <tr key={holding.symbol}>
              <td><strong>{holding.symbol}</strong></td>
              <td>{holding.name}</td>
              <td>{holding.theme}</td>
              <td>{formatWeight(holding.targetWeight)}</td>
              <td>{formatWeight(holding.currentWeight)}</td>
              <td>{formatCurrency(holding.price)}</td>
              <td className={holding.changePercent >= 0 ? 'positive' : 'negative'}>{formatPercent(holding.changePercent)}</td>
              <td className={holding.dayContributionPercent >= 0 ? 'positive' : 'negative'}>{formatPercent(holding.dayContributionPercent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MethodItem({ label, value }) {
  return (
    <div className="method-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNav(value) {
  return Number(value).toFixed(2);
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value) {
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
}

function formatSigned(value) {
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}`;
}

function formatWeight(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(`${value}T00:00:00`));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}
