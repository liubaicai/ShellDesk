import { t, useCurrentAppLanguage } from '../i18n';

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
  const language = useCurrentAppLanguage();

  return (
    <>
      <div className="command-bar no-drag key-command-bar">
        <label className="global-search">
          <span>{t('keys.search.label', language)}</span>
          <input
            type="search"
            placeholder={t('keys.search.placeholder', language)}
            value={keySearchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>

        <button type="button" className="command-button key-import-button" onClick={onImportPrivateKey}>{t('keys.import', language)}</button>
        <button type="button" className="primary-action key-create-button" onClick={onCreateKey}>{t('keys.createRsa', language)}</button>
      </div>

      <section className="vault-content">
        <div className="content-filter-row">
          <button type="button" className={`filter-tab ${!keySearchQuery ? 'active' : ''}`} onClick={() => onSearchChange('')}>
            {t('keys.list', language)}
          </button>
          <span>{t('keys.count', language, { count: filteredKeys.length })}</span>
        </div>
        {filteredKeys.length ? (
          <div className="key-grid">
            {filteredKeys.map((key) => (
              <article key={key.id} className="key-card">
                <span className="key-card-icon">🔑</span>
                <span className="key-card-summary">
                  <strong>{key.name}</strong>
                  <em>{key.fingerprint || (key.publicKey ? t('keys.publicKey.loaded', language) : t('keys.publicKey.missing', language))}</em>
                </span>
                <div className="key-card-actions">
                  {key.publicKey ? <button type="button" onClick={() => onCopyPublicKey(key)}>{t('keys.copyPublicKey', language)}</button> : null}
                  <button type="button" onClick={() => onEditKey(key)}>{t('keys.edit', language)}</button>
                  <button type="button" className="danger-text" onClick={() => onDeleteKey(key)}>{t('keys.delete', language)}</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <span>KEYS</span>
            <h3>{sshKeys.length ? t('keys.empty.noMatches.title', language) : t('keys.empty.noKeys.title', language)}</h3>
            <p>{sshKeys.length ? t('keys.empty.noMatches.description', language) : t('keys.empty.noKeys.description', language)}</p>
          </div>
        )}
      </section>
    </>
  );
}

export default KeysPage;
