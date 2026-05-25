interface SshKey {
  id: string;
  name: string;
  source: 'imported' | 'generated';
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  passphrase: string;
  createdAt: string;
  updatedAt: string;
}

interface KeysPageProps {
  keySearchQuery: string;
  filteredKeys: SshKey[];
  sshKeys: SshKey[];
  onSearchChange: (value: string) => void;
  onImportPrivateKey: () => void;
  onCreateKey: () => void;
  onEditKey: (key: SshKey) => void;
  onDeleteKey: (key: SshKey) => void;
  onCopyPublicKey: (key: SshKey) => void;
}

function KeysPage({
  keySearchQuery,
  filteredKeys,
  sshKeys,
  onSearchChange,
  onImportPrivateKey,
  onCreateKey,
  onEditKey,
  onDeleteKey,
  onCopyPublicKey,
}: KeysPageProps) {
  return (
    <>
      <div className="command-bar no-drag key-command-bar">
        <label className="global-search">
          <span>查找</span>
          <input
            type="search"
            placeholder="查找密钥名称、算法或指纹"
            value={keySearchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>

        <button type="button" className="command-button key-import-button" onClick={onImportPrivateKey}>导入密钥对</button>
        <button type="button" className="primary-action key-create-button" onClick={onCreateKey}>+ 新建 RSA 密钥</button>
      </div>

      <section className="vault-content">
        <div className="content-filter-row">
          <button type="button" className={`filter-tab ${!keySearchQuery ? 'active' : ''}`} onClick={() => onSearchChange('')}>
            密钥列表
          </button>
          <span>{filteredKeys.length} 个密钥</span>
        </div>
        {filteredKeys.length ? (
          <div className="key-grid">
            {filteredKeys.map((key) => (
              <article key={key.id} className="key-card">
                <span className="key-card-icon">🔑</span>
                <span className="key-card-summary">
                  <strong>{key.name}</strong>
                  <small>{key.source === 'generated' ? '本地生成' : '导入复制'} · {key.algorithm || 'SSH'}</small>
                  <em>{key.fingerprint || (key.publicKey ? '已载入公钥' : '未提供公钥')}</em>
                </span>
                <div className="key-card-actions">
                  {key.publicKey ? <button type="button" onClick={() => onCopyPublicKey(key)}>复制公钥</button> : null}
                  <button type="button" onClick={() => onEditKey(key)}>编辑</button>
                  <button type="button" className="danger-text" onClick={() => onDeleteKey(key)}>删除</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <span>KEYS</span>
            <h3>{sshKeys.length ? '没有匹配的密钥' : '密钥列表为空'}</h3>
            <p>{sshKeys.length ? '清空搜索后再试。' : '点击“新建 RSA 密钥”或“导入密钥对”添加第一把 SSH 密钥。'}</p>
          </div>
        )}
      </section>
    </>
  );
}

export default KeysPage;
