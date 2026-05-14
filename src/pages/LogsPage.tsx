function LogsPage() {
  return (
    <>
      <div className="command-bar no-drag simple-command-bar">
        <strong>日志</strong>
      </div>
      <section className="vault-content">
        <div className="empty-state">
          <span>LOGS</span>
          <h3>暂无日志</h3>
          <p>连接、密钥和操作日志后续会显示在这里。</p>
        </div>
      </section>
    </>
  );
}

export default LogsPage;
