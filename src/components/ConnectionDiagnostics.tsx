import { useEffect, useState } from "react";
import type { ConnectionReport } from "../../shared/diagnostics";

export function ConnectionDiagnostics({ request, onBack }: { request: number; onBack: () => void }) {
  const [report, setReport] = useState<ConnectionReport>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [installing, setInstalling] = useState(false);
  const refresh = () => setRevision(n => n + 1);

  useEffect(() => {
    let current = true;
    setError("");
    window.light.getDiagnostics().then(
      data => { if (current) setReport(data); },
      () => { if (current) setError("读取失败，请刷新重试。"); },
    );
    return () => { current = false; };
  }, [revision, request]);

  async function install() {
    setInstalling(true);
    try {
      await window.light.installHooks?.();
      refresh();
    } catch {
      setError("未能接入 Hooks，请重试。");
    } finally {
      setInstalling(false);
    }
  }

  const outcome = report?.lastInstall;
  const installButton = (
    <button type="button" onClick={install} disabled={installing}>
      {installing ? "正在接入…" : !outcome ? "接入 Hooks" : outcome.ok ? "重新接入" : "重试"}
    </button>
  );

  return (
    <>
      <header className="section-head diagnostics-header">
        <h2><button className="diagnostics-back" type="button" autoFocus onClick={onBack} aria-label="返回会话" data-hint="返回会话">
          <span aria-hidden="true">‹</span>连接与诊断
        </button></h2>
        <button className="link-btn" type="button" onClick={refresh}>刷新</button>
      </header>
      <div className="panel-sessions diagnostics-body">
        {error && <div role="status" className="diagnostics-message">{error}</div>}
        {report ? <>
          <section className="diagnostics-card">
            <h3>本地事件服务</h3>
            <dl className="service-facts">
              <div><dt>状态</dt><dd className={report.service.running ? "connected" : "connection-warning"}>{report.service.status}</dd></div>
              <div><dt>地址</dt><dd className="service-address">{report.service.address}</dd></div>
              <div><dt>模式</dt><dd>仅本机 · 无云端</dd></div>
            </dl>
          </section>
          {report.adapters.length > 0 && <section className="adapter-list" aria-label="Agent 接入">
            <h3 className="diagnostics-caption">Agent 接入</h3>
            {report.adapters.map(a => (
              <article className="diagnostics-card" key={a.name}>
                <div className="adapter-heading"><h3>{a.name}</h3><span data-hint={a.received ? undefined : "本次启动尚未收到事件"} className={a.configured ? "connected" : "connection-warning"}>{a.status}</span></div>
                {a.configPath && <code className="adapter-path">{a.configPath}</code>}
                {a.received && <p className="adapter-receipt">最近事件　{a.received}</p>}
              </article>
            ))}
          </section>}
          {report.lastFailure && <section className="diagnostics-card">
            <h3>上次跳转失败</h3><p className="adapter-receipt">{report.lastFailure.target} · {report.lastFailure.at}</p>
            <p className="diagnostics-message">{report.lastFailure.reason}</p>
          </section>}
        </> : !error && <div className="empty">正在检查连接…</div>}
      </div>
      {window.light.installHooks && <footer className="diagnostics-footer">
        {outcome && <details className="install-result">
          <summary className={outcome.ok ? "connected" : "connection-warning"}>
            <span role="status">{outcome.ok ? "✓ " : ""}{outcome.summary}</span>
            <span className="install-detail-label">详情</span>
          </summary>
          <p>{outcome.detail}</p>
          {outcome.ok && installButton}
        </details>}
        {!outcome?.ok && installButton}
      </footer>}
    </>
  );
}
