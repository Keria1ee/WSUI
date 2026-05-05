import { useEffect, useMemo, useState } from 'react';

const PASSWORD_KEY = 'wsui-password';

const themeLabels = {
  'AI Compute': 'Compute',
  Storage: 'Storage',
  Memory: 'Memory',
  'Cloud Infrastructure': 'Cloud',
  'Semiconductor Manufacturing': 'Semis'
};

export default function App() {
  const isAlphaPage = window.location.pathname.replace(/\/+$/, '') === '/alpha';
  const [health, setHealth] = useState(null);
  const [password, setPassword] = useState(() => sessionStorage.getItem(PASSWORD_KEY) || '');
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState(null);
  const [alpha, setAlpha] = useState(null);
  const [performanceView, setPerformanceView] = useState('marketPrice');
  const [alphaForm, setAlphaForm] = useState({ name: '', pickA: 'NVDA', costA: '', pickB: 'MU', costB: '' });
  const [alphaMessage, setAlphaMessage] = useState('');
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
        const [snapshotData, historyData, alphaData] = await Promise.all([
          apiGet('/api/snapshot'),
          apiGet('/api/history'),
          apiGet('/api/alpha')
        ]);
        if (isMounted) {
          setSnapshot(snapshotData);
          setHistory(historyData);
          setAlpha(alphaData);
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

  async function apiPost(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(password ? { 'x-wsui-password': password } : {})
      },
      body: JSON.stringify(body)
    });

    if (response.status === 401) {
      sessionStorage.removeItem(PASSWORD_KEY);
      setPassword('');
      throw new Error('Password required');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || `Request failed: ${response.status}`);
    }

    return data;
  }

  async function submitAlphaPicks(event) {
    event.preventDefault();
    setAlphaMessage('');

    try {
      const nextAlpha = await apiPost('/api/alpha/picks', alphaForm);
      setAlpha(nextAlpha);
      setAlphaMessage('Picks saved. Your next-round influence is now recalculated.');
    } catch (requestError) {
      setAlphaMessage(requestError.message);
    }
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
      <Header currentPage={isAlphaPage ? 'alpha' : 'home'} />

      {snapshot.source.mode !== 'market' && (
        <div className="system-banner">
          Quote mode: {snapshot.source.mode}. Add <code>FINNHUB_API_KEY</code> in <code>.env</code> to sync market quotes.
        </div>
      )}

      {snapshot.source.baselineStatus !== 'configured' && (
        <div className="system-banner muted-banner">
          Launch prices are derived from previous close values until inception prices are frozen in <code>data/fund.json</code>.
        </div>
      )}

      {isAlphaPage ? (
        <>
          <AlphaEnginePage
            alpha={alpha}
            form={alphaForm}
            message={alphaMessage}
            onFormChange={setAlphaForm}
            onSubmit={submitAlphaPicks}
          />
          <Footer snapshot={snapshot} />
        </>
      ) : (
        <>
      <Hero snapshot={snapshot} holdings={sortedByTarget} />
      <AnchorNav />
      <OverviewSection snapshot={snapshot} />
      <HoldingsSection snapshot={snapshot} holdings={sortedByTarget} />
      <PerformanceSection
        snapshot={snapshot}
        history={history}
        view={performanceView}
        onViewChange={setPerformanceView}
      />
      <DocumentsSection />
      <PremiumDiscountSection snapshot={snapshot} />
      <FaqSection snapshot={snapshot} />
      <Footer snapshot={snapshot} />
        </>
      )}
    </main>
  );
}

function Header({ currentPage }) {
  return (
    <header className="site-header">
      <div className="page-shell header-inner">
        <a className="wordmark" href="/" aria-label="WSUI home">
          <span>WSUI</span>
        </a>
        <nav className="primary-nav">
          <a className={currentPage === 'home' ? 'active' : ''} href="/#overview">Our Index</a>
          <a className={currentPage === 'alpha' ? 'active' : ''} href="/alpha">Alpha Engine</a>
          <a href="/#holdings">Holdings</a>
          <a href="/#performance">Performance</a>
          <a href="/#faq">FAQ</a>
        </nav>
      </div>
    </header>
  );
}

function Hero({ snapshot, holdings }) {
  return (
    <section className="hero" id="top">
      <div className="page-shell hero-grid">
        <div className="hero-copy">
          <p className="fund-type">Simulated U.S. Equity Index</p>
          <h1>{snapshot.fund.ticker} {snapshot.fund.name}</h1>
          <p className="hero-text">
            A private group simulation tracking the AI infrastructure stack across compute,
            memory, storage, cloud infrastructure, and semiconductor manufacturing.
          </p>
          <div className="hero-buttons">
            <a className="button primary-button" href="#holdings">View Holdings</a>
            <a className="button ghost-button" href="/alpha">Enter Alpha Engine</a>
          </div>
        </div>

        <aside className="hero-holdings" aria-label="Top holdings">
          <div className="hero-holdings-heading">
            <h2>Top 5 Holdings</h2>
            <span>as of {formatShortDate(snapshot.performance.asOf)}</span>
          </div>
          <div className="logo-row">
            {holdings.map((holding) => (
              <div className="logo-mark" key={holding.symbol}>
                <strong>{holding.symbol}</strong>
                <span>{themeLabels[holding.theme] || holding.theme}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

function AnchorNav() {
  return (
    <nav className="anchor-nav" aria-label="Page sections">
      <div className="page-shell anchor-inner">
        <a href="#overview">Overview</a>
        <a href="#holdings">Top Holdings</a>
        <a href="#performance">Performance</a>
        <a href="#documents">Documents</a>
        <a href="#premium-discount">Premium/Discount</a>
        <a href="#faq">FAQ</a>
      </div>
    </nav>
  );
}

function OverviewSection({ snapshot }) {
  return (
    <section className="section" id="overview">
      <div className="page-shell overview-layout">
        <div>
          <h2>Overview</h2>
          <p className="large-copy">
            WSUI is built to simulate exposure to the picks and themes behind the West Side
            AI infrastructure discussion, with a launch basket that drifts as real market prices move.
          </p>
          <div className="why-grid">
            <Reason title="AI Infrastructure" text="Focused on the hardware and infrastructure layer behind the AI buildout." />
            <Reason title="Targeted Basket" text="A concentrated group of U.S.-listed names rather than broad market exposure." />
            <Reason title="Held, Not Reset Daily" text="Target weights set the launch basket; current weights drift with price movement." />
          </div>
        </div>

        <div className="fund-details">
          <h3>Fund Details</h3>
          <DetailRow label="Ticker" value={snapshot.fund.ticker} />
          <DetailRow label="Primary Exchange" value="Private Simulation" />
          <DetailRow label="Expense Ratio" value="0.00%" />
          <DetailRow label="Launch" value={formatDate(snapshot.fund.inceptionDate)} />
          <DetailRow label="# of Holdings" value={String(snapshot.holdings.length)} />
          <DetailRow label="Benchmark" value={snapshot.benchmark.symbol} />
          <DetailRow label="Management Style" value="Group Simulated" />
          <DetailRow label="Rebalance" value="Manual" />
        </div>
      </div>
    </section>
  );
}

function Reason({ title, text }) {
  return (
    <article className="reason">
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AlphaEnginePage({ alpha, form, message, onFormChange, onSubmit }) {
  const topWeights = alpha?.nextWeights?.slice(0, 8) || [];
  const members = alpha?.members || [];
  const leader = alpha?.stats?.alphaLeader;

  return (
    <section className="alpha-page" id="alpha-engine">
      <div className="alpha-hero-band">
        <div className="page-shell alpha-hero-grid">
          <div className="alpha-hero-copy">
            <p className="fund-type">WSUI Alpha Lab</p>
            <h1>Contributor Alpha Engine</h1>
            <p>
              Two lines per member. Cost matters. Momentum matters. Risk matters. The engine prices each
              contributor's recent skill into the next WSUI consensus instead of counting every pick equally.
            </p>
            <div className="alpha-hero-actions">
              <a className="button primary-button" href="#submit-picks">Submit Picks</a>
              <a className="button ghost-button" href="/">Back to Index</a>
            </div>
          </div>

          <div className="alpha-command">
            <div>
              <span>Next Rebalance</span>
              <strong>{alpha?.round?.nextRebalanceAt ? formatDate(alpha.round.nextRebalanceAt) : 'N/A'}</strong>
              <em>{alpha?.round?.daysRemaining ?? 0} days remaining</em>
            </div>
            <div>
              <span>Alpha Leader</span>
              <strong>{leader?.name || 'Open'}</strong>
              <em>{leader ? `${formatPercent(leader.sevenDayReturn * 100)} 7D` : 'Waiting for picks'}</em>
            </div>
            <div>
              <span>Unity Score</span>
              <strong>{formatAbsolutePercent((alpha?.stats?.unityScore || 0) * 100)}</strong>
              <em>top three next weights</em>
            </div>
          </div>
        </div>
      </div>

      <div className="page-shell alpha-score-model">
        <div>
          <p className="fund-type">Scoring Model</p>
          <h2>Economic Weighting, Not Voting</h2>
        </div>
        <div className="score-factor-grid">
          <ScoreFactor value="42%" label="7D return" text="Recent market performance rewards timely picks." />
          <ScoreFactor value="42%" label="Cost return" text="A member's stated basis affects the economic score." />
          <ScoreFactor value="-16%" label="Volatility" text="Unstable picks carry a risk drag." />
          <ScoreFactor value="Penalty" label="Chase risk" text="Extended names near recent highs get a small haircut." />
        </div>
      </div>

      <div className="page-shell alpha-main-grid">
        <form className="alpha-submit-panel" id="submit-picks" onSubmit={onSubmit}>
          <div className="panel-heading">
            <div>
              <p className="fund-type">Your Allocation Lines</p>
              <h2>Submit Picks</h2>
            </div>
            <span>2 different tickers</span>
          </div>

          <label>
            Member Name
            <input
              value={form.name}
              onChange={(event) => onFormChange({ ...form, name: event.target.value })}
              placeholder="Your group name"
            />
          </label>

          <div className="line-entry-grid">
            <PickLine
              number="01"
              ticker={form.pickA}
              cost={form.costA}
              tickerPlaceholder="NVDA"
              onTickerChange={(value) => onFormChange({ ...form, pickA: value.toUpperCase() })}
              onCostChange={(value) => onFormChange({ ...form, costA: value })}
            />
            <PickLine
              number="02"
              ticker={form.pickB}
              cost={form.costB}
              tickerPlaceholder="MU"
              onTickerChange={(value) => onFormChange({ ...form, pickB: value.toUpperCase() })}
              onCostChange={(value) => onFormChange({ ...form, costB: value })}
            />
          </div>

          <button type="submit">Save Picks</button>
          {message && <p className={message.includes('saved') ? 'alpha-message' : 'alpha-error'}>{message}</p>}
          <p className="form-help">Empty costs are locked at the market price when submitted. Same-member duplicate tickers are rejected.</p>
        </form>

        <div className="alpha-dashboard">
          <div className="alpha-stats">
            <StatTile label="Members" value={String(alpha?.stats?.memberCount || 0)} />
            <StatTile label="Tickers" value={String(alpha?.stats?.tickerCount || 0)} />
            <StatTile label="Max Ticker" value={formatAbsolutePercent((alpha?.settings?.maxTickerWeight || 0) * 100)} />
          </div>

          <div className="alpha-panel weights-panel">
            <div className="panel-heading">
              <h3>Next WSUI Weights</h3>
              <span>preview</span>
            </div>
            {topWeights.length ? (
              <div className="weight-list">
                {topWeights.map((holding, index) => (
                  <div className="weight-row" key={holding.symbol}>
                    <small>{String(index + 1).padStart(2, '0')}</small>
                    <div>
                      <strong>{holding.symbol}</strong>
                      <span>{holding.theme}</span>
                    </div>
                    <div className="weight-bar">
                      <span style={{ width: `${Math.max(holding.weight * 100, 2)}%` }} />
                    </div>
                    <em>{formatWeight(holding.weight)}</em>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">Submit the first two lines to start the alpha round.</p>
            )}
          </div>
        </div>
      </div>

      <div className="page-shell alpha-board-grid">
        <div className="alpha-panel">
            <div className="panel-heading">
              <h3>Contributor Alpha Board</h3>
            <span>score-driven influence</span>
            </div>
            {members.length ? (
              <div className="member-list">
                {members.map((member) => (
                  <div className="member-row" key={member.name}>
                    <div>
                      <strong>{member.name}</strong>
                      <span>{member.picks.map((pick) => `${pick.symbol} @ ${formatCurrency(pick.costBasis)}`).join(' / ')}</span>
                    </div>
                    <div className="member-metrics">
                      <em>{formatPercent(member.sevenDayReturn * 100)} 7D</em>
                      <em>{formatPercent(member.costReturn * 100)} cost</em>
                      <strong>{formatNumber(member.projectedInfluence)}x</strong>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">The board fills in as members submit picks.</p>
            )}
          </div>

        <div className="alpha-panel">
          <div className="panel-heading">
            <h3>Risk Controls</h3>
            <span>guardrails</span>
          </div>
          <div className="guardrail-list">
            <DetailRow label="Round Length" value={`${alpha?.settings?.roundLengthDays || 7} Days`} />
            <DetailRow label="Influence Range" value={`${formatNumber(alpha?.settings?.minInfluence || 0.3)}x - ${formatNumber(alpha?.settings?.maxInfluence || 3)}x`} />
            <DetailRow label="Smoothing" value={formatAbsolutePercent((alpha?.settings?.smoothing || 0) * 100)} />
            <DetailRow label="Ticker Cap" value={formatAbsolutePercent((alpha?.settings?.maxTickerWeight || 0) * 100)} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ScoreFactor({ value, label, text }) {
  return (
    <article className="score-factor">
      <strong>{value}</strong>
      <h3>{label}</h3>
      <p>{text}</p>
    </article>
  );
}

function PickLine({ number, ticker, cost, tickerPlaceholder, onTickerChange, onCostChange }) {
  return (
    <div className="pick-line">
      <span>{number}</span>
      <label>
        Ticker
        <input
          value={ticker}
          onChange={(event) => onTickerChange(event.target.value)}
          placeholder={tickerPlaceholder}
        />
      </label>
      <label>
        Cost Basis
        <input
          inputMode="decimal"
          value={cost}
          onChange={(event) => onCostChange(event.target.value)}
          placeholder="optional"
        />
      </label>
    </div>
  );
}

function StatTile({ label, value }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HoldingsSection({ snapshot, holdings }) {
  return (
    <section className="section" id="holdings">
      <div className="page-shell">
        <div className="section-heading">
          <h2>Holdings</h2>
          <p>As of {formatDate(snapshot.performance.asOf)}</p>
        </div>

        <div className="holdings-actions">
          <button type="button">View All +</button>
          <button type="button">Download CSV</button>
          <button type="button">Download PDF</button>
        </div>

        <HoldingsTable holdings={holdings} />

        <p className="table-note">
          WSUI holdings and allocations are part of a private simulation and are subject to change at any time.
        </p>
      </div>
    </section>
  );
}

function HoldingsTable({ holdings }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Ticker</th>
            <th>Theme</th>
            <th>Target Weight</th>
            <th>Current Weight</th>
            <th>Price</th>
            <th>Day Change</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((holding) => (
            <tr key={holding.symbol}>
              <td>{holding.name}</td>
              <td><strong>{holding.symbol}</strong></td>
              <td>{holding.theme}</td>
              <td>{formatWeight(holding.targetWeight)}</td>
              <td>{formatWeight(holding.currentWeight)}</td>
              <td>{formatCurrency(holding.price)}</td>
              <td className={holding.changePercent >= 0 ? 'positive' : 'negative'}>{formatPercent(holding.changePercent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerformanceSection({ snapshot, history, view, onViewChange }) {
  const metric = snapshot.performance[view];
  const isMarketPrice = view === 'marketPrice';

  return (
    <section className="section" id="performance">
      <div className="page-shell performance-shell">
        <div className="performance-heading">
          <h2>Performance</h2>
          <span>As of {formatDate(snapshot.performance.asOf)}</span>
        </div>

        <div className="performance-tabs" role="tablist" aria-label="Performance view">
          <button
            className={isMarketPrice ? 'active' : ''}
            type="button"
            onClick={() => onViewChange('marketPrice')}
          >
            Market Price
          </button>
          <button
            className={!isMarketPrice ? 'active' : ''}
            type="button"
            onClick={() => onViewChange('nav')}
          >
            NAV
          </button>
        </div>

        <PerformanceChart points={history?.points || []} metric={metric} valueKey={view} />

        <div className="performance-table">
          <PerformanceRow label={isMarketPrice ? 'Closing Price' : 'Net Asset Value'} value={formatCurrency(metric.current)} strong />
          <PerformanceRow label="Change ($)" value={formatCurrency(metric.change)} strong />
          <PerformanceRow label="Change (%)" value={formatPercent(metric.changePercent)} strong />
          {isMarketPrice ? (
            <PerformanceRow label="30-Day Median Bid/Ask Spread" value={formatAbsolutePercent(metric.medianBidAskSpreadPercent)} strong />
          ) : (
            <PerformanceRow label="Premium/Discount" value={formatAbsolutePercent(((snapshot.marketPrice - snapshot.nav) / snapshot.nav) * 100)} strong />
          )}
          <PerformanceSubhead label="Annualized Performance" />
          <PerformanceRow label={`1 Year (as of ${formatShortDate(snapshot.performance.asOf)})`} value="N/A" />
          <PerformanceRow label={`3 Year (as of ${formatShortDate(snapshot.performance.asOf)})`} value="N/A" />
          <PerformanceRow label={`5 Year (as of ${formatShortDate(snapshot.performance.asOf)})`} value="N/A" />
          <PerformanceRow label={`Since Inception (as of ${formatShortDate(snapshot.performance.asOf)})`} value={formatPercent(metric.totalReturnPercent)} strong />
        </div>

        <p className="performance-note">
          The performance data quoted represents a private simulation. Past performance does not guarantee future results.
          Market Price is a configurable simulated price and defaults to NAV when no premium or discount is set.
        </p>
      </div>
    </section>
  );
}

function PerformanceChart({ points, metric, valueKey }) {
  const cleanPoints = points
    .filter((point) => Number.isFinite(Number(point[valueKey])))
    .map((point) => ({
      date: point.date,
      value: Number(point[valueKey])
    }));
  const chartPoints = cleanPoints.length >= 2
    ? cleanPoints
    : [
        { date: 'Start', value: metric.initial },
        { date: 'Now', value: metric.current }
      ];
  const values = chartPoints.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const paddingValue = Math.max((rawMax - rawMin) * 0.18, rawMax * 0.02, 1);
  const min = Math.max(0, rawMin - paddingValue);
  const max = rawMax + paddingValue;
  const width = 960;
  const height = 360;
  const left = 66;
  const right = 18;
  const top = 18;
  const bottom = 58;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const xStep = chartPoints.length > 1 ? innerWidth / (chartPoints.length - 1) : 0;
  const yFor = (value) => {
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    return top + (1 - ratio) * innerHeight;
  };
  const xFor = (index) => left + index * xStep;
  const linePoints = chartPoints.map((point, index) => `${xFor(index)},${yFor(point.value)}`).join(' ');
  const areaPoints = `${left},${height - bottom} ${linePoints} ${xFor(chartPoints.length - 1)},${height - bottom}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((tick) => min + (max - min) * tick);
  const labelInterval = Math.max(1, Math.ceil(chartPoints.length / 6));
  const labelIndexes = chartPoints
    .map((_point, index) => index)
    .filter((index) => index === 0 || index === chartPoints.length - 1 || index % labelInterval === 0);

  return (
    <div className="performance-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric.label} performance chart`}>
        <defs>
          <linearGradient id="performance-area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#aeb6c4" stopOpacity="0.56" />
            <stop offset="100%" stopColor="#aeb6c4" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} y1={yFor(tick)} x2={width - right} y2={yFor(tick)} className="performance-grid-line" />
            <text x={left - 12} y={yFor(tick) + 4} textAnchor="end" className="performance-axis-label">
              {formatChartCurrency(tick)}
            </text>
          </g>
        ))}
        <polygon points={areaPoints} className="performance-area" />
        <polyline points={linePoints} className="performance-line" />
        {labelIndexes.map((index) => (
          <text key={`${chartPoints[index].date}-${index}`} x={xFor(index)} y={height - 22} textAnchor="middle" className="performance-date-label">
            {formatChartDate(chartPoints[index].date)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function PerformanceRow({ label, value, strong }) {
  return (
    <div className="performance-row">
      <span>{label}</span>
      <strong className={strong ? '' : 'muted-value'}>{value}</strong>
    </div>
  );
}

function PerformanceSubhead({ label }) {
  return (
    <div className="performance-subhead">
      <strong>{label}</strong>
    </div>
  );
}

function DocumentsSection() {
  return (
    <section className="section documents-section" id="documents">
      <div className="page-shell">
        <h2>Fund Documents</h2>
        <div className="document-links">
          <a href="#documents">Fact Sheet</a>
          <a href="#documents">Methodology</a>
          <a href="#documents">Simulation Notes</a>
        </div>
      </div>
    </section>
  );
}

function PremiumDiscountSection({ snapshot }) {
  const premiumDiscount = ((snapshot.marketPrice - snapshot.nav) / snapshot.nav) * 100;

  return (
    <section className="section" id="premium-discount">
      <div className="page-shell premium-grid">
        <h2>Premium/Discount</h2>
        <div className="premium-table">
          <DetailRow label="NAV" value={formatCurrency(snapshot.nav)} />
          <DetailRow label="Market Price" value={formatCurrency(snapshot.marketPrice)} />
          <DetailRow label="Premium/Discount" value={formatAbsolutePercent(premiumDiscount)} />
          <DetailRow label="30-Day Median Bid/Ask Spread" value={formatAbsolutePercent(snapshot.performance.marketPrice.medianBidAskSpreadPercent)} />
        </div>
      </div>
    </section>
  );
}

function FaqSection({ snapshot }) {
  return (
    <section className="section" id="faq">
      <div className="page-shell faq-layout">
        <h2>FAQ</h2>
        <FaqItem
          question={`When did ${snapshot.fund.ticker} launch?`}
          answer={`${snapshot.fund.ticker} began its private simulation on ${formatDate(snapshot.fund.inceptionDate)}.`}
        />
        <FaqItem
          question="Can I trade WSUI?"
          answer="No. WSUI is a private group simulation and is not a registered security, ETF, or investment product."
        />
        <FaqItem
          question="How is the index calculated?"
          answer="The launch basket is created from target weights, then simulated holdings drift with market prices until the group records a rebalance."
        />
      </div>
    </section>
  );
}

function FaqItem({ question, answer }) {
  return (
    <article className="faq-item">
      <h3>{question}</h3>
      <p>{answer}</p>
    </article>
  );
}

function Footer({ snapshot }) {
  return (
    <footer className="site-footer">
      <div className="page-shell footer-grid">
        <div>
          <strong>{snapshot.fund.ticker} {snapshot.fund.name}</strong>
          <p>{snapshot.fund.disclaimer}</p>
        </div>
        <div className="footer-links">
          <a href="#overview">Overview</a>
          <a href="#holdings">Holdings</a>
          <a href="#performance">Performance</a>
        </div>
      </div>
    </footer>
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

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value);
}

function formatChartCurrency(value) {
  return `$${Number(value).toFixed(0)}`;
}

function formatPercent(value) {
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
}

function formatAbsolutePercent(value) {
  return `${Number(value).toFixed(2)}%`;
}

function formatWeight(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return Number(value || 0).toFixed(2);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  }).format(new Date(`${value}T00:00:00`));
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit'
  }).format(new Date(`${value}T00:00:00`));
}

function formatChartDate(value) {
  if (value === 'Start' || value === 'Now') {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric'
  }).format(new Date(`${value}T00:00:00`));
}
