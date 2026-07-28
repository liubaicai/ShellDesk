import type { MouseEvent as ReactMouseEvent } from 'react';

import { tCurrent } from '../../i18n';
import { formatSqlPreview, formatTimestamp } from './databaseUtils';
import type { MysqlHistoryItem, TableInfo } from './mysqlWorkbenchModel';

interface FilteredDatabase {
  database: string;
  tables: string[];
  databaseMatched: boolean;
}

interface RemoteMySQLSidebarProps {
  activeDatabase: string;
  databaseTables: Record<string, string[]>;
  databases: string[];
  expandedDatabases: Set<string>;
  filteredDatabases: FilteredDatabase[];
  history: MysqlHistoryItem[];
  loadingDatabases: Set<string>;
  objectSearch: string;
  schemaLoading: boolean;
  selectedTable: TableInfo | null;
  onCreateDatabase: () => void;
  onCreateTable: () => void;
  onDatabaseContextMenu: (event: ReactMouseEvent<HTMLElement>, database: string) => void;
  onImport: () => void;
  onRefreshDatabase: (database: string, event?: ReactMouseEvent<HTMLElement>) => void;
  onRefreshDatabases: () => void;
  onSearchChange: (value: string) => void;
  onSelectTable: (database: string, table: string) => void;
  onTableContextMenu: (event: ReactMouseEvent<HTMLElement>, database: string, table: string) => void;
  onToggleDatabase: (database: string) => void;
  onUseHistory: (item: MysqlHistoryItem) => void;
}

export function RemoteMySQLSidebar({
  activeDatabase,
  databaseTables,
  databases,
  expandedDatabases,
  filteredDatabases,
  history,
  loadingDatabases,
  objectSearch,
  schemaLoading,
  selectedTable,
  onCreateDatabase,
  onCreateTable,
  onDatabaseContextMenu,
  onImport,
  onRefreshDatabase,
  onRefreshDatabases,
  onSearchChange,
  onSelectTable,
  onTableContextMenu,
  onToggleDatabase,
  onUseHistory,
}: RemoteMySQLSidebarProps) {
  return (
    <aside className="mysql-sidebar">
      <div className="mysql-sidebar-header">
        <div>
          <strong>{tCurrent('auto.remoteMySQL.dzec2g')}</strong>
          <span>{databases.length} {tCurrent('auto.remoteMySQL.1bg3e3c')}</span>
        </div>
        <div className="mysql-sidebar-actions">
          <button type="button" className="mysql-sidebar-text-action" onClick={onCreateDatabase} title={tCurrent('auto.remoteMySQL.createDatabase')}>DB+</button>
          <button type="button" className="mysql-sidebar-text-action" data-testid="mysql-create-table-open" onClick={onCreateTable} title={tCurrent('auto.remoteMySQL.createTable')}>T+</button>
          <button type="button" onClick={onImport} title={tCurrent('auto.remoteMySQL.importData')}>⇧</button>
          <button type="button" onClick={onRefreshDatabases} disabled={schemaLoading} title={tCurrent('auto.remoteMySQL.oj1z9s')}>
            {schemaLoading ? '...' : '↻'}
          </button>
        </div>
      </div>
      <div className="mysql-object-search">
        <input
          type="search"
          value={objectSearch}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={tCurrent('auto.remoteMySQL.jj14o6')}
          spellCheck={false}
        />
        {objectSearch ? <button type="button" onClick={() => onSearchChange('')} title={tCurrent('auto.remoteMySQL.18bjen0')}>×</button> : null}
      </div>
      <div className="mysql-tree">
        {filteredDatabases.map(({ database, tables, databaseMatched }) => {
          const expanded = expandedDatabases.has(database);
          const loading = loadingDatabases.has(database);
          const visibleTables = objectSearch.trim() && !databaseMatched ? tables : databaseTables[database] ?? [];

          return (
            <div key={database} className="mysql-tree-db">
              <button
                type="button"
                className={`mysql-tree-db-btn ${expanded ? 'expanded' : ''} ${activeDatabase === database ? 'active' : ''}`}
                onClick={() => onToggleDatabase(database)}
                onContextMenu={(event) => onDatabaseContextMenu(event, database)}
              >
                <span className="mysql-tree-arrow">{expanded ? '▾' : '▸'}</span>
                <span className="mysql-tree-icon">DB</span>
                <span className="mysql-tree-name">{database}</span>
                <span className="mysql-tree-count">{databaseTables[database]?.length ?? '-'}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="mysql-tree-refresh"
                  title={tCurrent('auto.remoteMySQL.tw6kuq')}
                  onClick={(event) => onRefreshDatabase(database, event)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') onRefreshDatabase(database);
                  }}
                >
                  ↻
                </span>
              </button>
              {expanded ? (
                <div className="mysql-tree-tables">
                  {loading ? <div className="mysql-tree-loading">{tCurrent('auto.remoteMySQL.ldc0z9')}</div> : null}
                  {!loading && visibleTables.map((table) => (
                    <div key={table}>
                      <button
                        type="button"
                        className={`mysql-tree-table-btn ${selectedTable?.database === database && selectedTable.name === table ? 'selected' : ''}`}
                        onClick={() => onSelectTable(database, table)}
                        onContextMenu={(event) => onTableContextMenu(event, database, table)}
                      >
                        <span className="mysql-tree-icon">T</span>
                        <span className="mysql-tree-name">{table}</span>
                      </button>
                    </div>
                  ))}
                  {!loading && databaseTables[database] !== undefined && visibleTables.length === 0
                    ? <div className="mysql-tree-empty">{tCurrent('auto.remoteMySQL.1r39nj')}</div>
                    : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {filteredDatabases.length === 0 ? <div className="mysql-tree-empty">{tCurrent('auto.remoteMySQL.1kuvtrp')}</div> : null}
      </div>
      <div className="mysql-history">
        <div className="mysql-history-title">
          <strong>{tCurrent('auto.remoteMySQL.air9hy')}</strong>
          <span>{history.length}</span>
        </div>
        <div className="mysql-history-list">
          {history.length === 0 ? (
            <div className="mysql-history-empty">{tCurrent('auto.remoteMySQL.mkpr6n')}</div>
          ) : history.map((item) => (
            <button key={item.id} type="button" className={`mysql-history-item ${item.status}`} onClick={() => onUseHistory(item)} title={item.sql}>
              <span className="mysql-history-sql">{formatSqlPreview(item.sql, 34)}</span>
              <span className="mysql-history-meta">
                {formatTimestamp(item.createdAt)}
                {item.status === 'success'
                  ? ` · ${item.affectedRows !== undefined ? tCurrent('auto.remoteMySQL.1p5p2l4', { value0: item.affectedRows }) : tCurrent('auto.remoteMySQL.18tehe02', { value0: item.rowCount ?? 0 })}`
                  : tCurrent('auto.remoteMySQL.gzim04')}
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
