import { useCallback, useEffect, useMemo, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { t, useCurrentAppLanguage } from '../../i18n';
import type { SettingsConfirmDialogConfig } from './settingsTypes';
import { SettingsCommandPreview, SettingsConfirmDialog, useRemoteSettingsCommand, withLinuxPrivilege } from './settingsShared';
import {
  buildAddGroupCommand,
  buildAddUserCommand,
  buildDeleteGroupCommand,
  buildDeleteUserCommand,
  buildEditUserCommand,
  buildGroupMemberCommand,
  buildUserDetailCommand,
  buildUserPasswordCommand,
  createEditDraftFromUser,
  isSafeAccountName,
  USER_MANAGER_SNAPSHOT_COMMAND,
  validateAddGroupDraft,
  validateAddUserDraft,
  validateEditUserDraft,
} from './userManagerCommands';
import { parseUserDetail, parseUserManagerSnapshot } from './userManagerParsers';
import type { AddGroupDraft, AddUserDraft, EditUserDraft, RemoteGroupRecord, RemoteUserDetail, RemoteUserManagerSnapshot, RemoteUserRecord, UserPasswordStatus } from './userManagerTypes';

type UserManagerView = 'users' | 'groups' | 'sudoers';

const EMPTY_SNAPSHOT: RemoteUserManagerSnapshot = {
  users: [],
  groups: [],
  sudoersLines: [],
};

const DEFAULT_ADD_USER_DRAFT: AddUserDraft = {
  username: '',
  uid: '',
  primaryGroup: '',
  home: '',
  shell: '/bin/bash',
  supplementaryGroups: '',
  createHome: true,
};

const DEFAULT_ADD_GROUP_DRAFT: AddGroupDraft = {
  name: '',
  gid: '',
};

function getPasswordStatusLabel(status: UserPasswordStatus, language: ReturnType<typeof useCurrentAppLanguage>) {
  switch (status) {
    case 'active': return t('remoteSettings.users.status.active', language);
    case 'locked': return t('remoteSettings.users.status.locked', language);
    case 'no-password': return t('remoteSettings.users.status.noPassword', language);
    default: return t('remoteSettings.users.status.unknown', language);
  }
}

function getValidationError(field: string, language: ReturnType<typeof useCurrentAppLanguage>) {
  switch (field) {
    case 'username': return t('remoteSettings.users.validation.username', language);
    case 'uid': return t('remoteSettings.users.validation.uid', language);
    case 'primaryGroup': return t('remoteSettings.users.validation.primaryGroup', language);
    case 'home': return t('remoteSettings.users.validation.home', language);
    case 'shell': return t('remoteSettings.users.validation.shell', language);
    case 'supplementaryGroups': return t('remoteSettings.users.validation.supplementaryGroups', language);
    case 'group': return t('remoteSettings.users.validation.group', language);
    case 'gid': return t('remoteSettings.users.validation.gid', language);
    default: return t('remoteSettings.users.validation.generic', language);
  }
}

function getPasswordActionCopy(action: 'lock' | 'unlock' | 'expire', language: ReturnType<typeof useCurrentAppLanguage>, user: string) {
  if (action === 'lock') {
    return {
      title: t('remoteSettings.users.lockTitle', language),
      message: t('remoteSettings.users.lockMessage', language, { user }),
      confirm: t('remoteSettings.users.lockConfirm', language),
      done: t('remoteSettings.users.lockDone', language, { user }),
    };
  }
  if (action === 'unlock') {
    return {
      title: t('remoteSettings.users.unlockTitle', language),
      message: t('remoteSettings.users.unlockMessage', language, { user }),
      confirm: t('remoteSettings.users.unlockConfirm', language),
      done: t('remoteSettings.users.unlockDone', language, { user }),
    };
  }
  return {
    title: t('remoteSettings.users.expireTitle', language),
    message: t('remoteSettings.users.expireMessage', language, { user }),
    confirm: t('remoteSettings.users.expireConfirm', language),
    done: t('remoteSettings.users.expireDone', language, { user }),
  };
}

function UserManagerViewTabs({
  activeView,
  language,
  onChange,
}: {
  activeView: UserManagerView;
  language: ReturnType<typeof useCurrentAppLanguage>;
  onChange: (view: UserManagerView) => void;
}) {
  const views: Array<{ key: UserManagerView; label: string }> = [
    { key: 'users', label: t('remoteSettings.users.view.users', language) },
    { key: 'groups', label: t('remoteSettings.users.view.groups', language) },
    { key: 'sudoers', label: t('remoteSettings.users.view.sudoers', language) },
  ];

  return (
    <div className="settings-segmented-control" role="tablist">
      {views.map((view) => (
        <button
          key={view.key}
          type="button"
          className={activeView === view.key ? 'active' : ''}
          onClick={() => onChange(view.key)}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}

function UserAddForm({
  draft,
  language,
  running,
  onChange,
  onSubmit,
}: {
  draft: AddUserDraft;
  language: ReturnType<typeof useCurrentAppLanguage>;
  running: boolean;
  onChange: (draft: AddUserDraft) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="settings-section user-manager-form-section">
      <h4>{t('remoteSettings.users.addUser', language)}</h4>
      <div className="user-manager-form-grid">
        <input className="settings-input" value={draft.username} placeholder={t('remoteSettings.users.username', language)} onChange={(event) => onChange({ ...draft, username: event.target.value })} />
        <input className="settings-input" value={draft.uid} placeholder={t('remoteSettings.users.uidOptional', language)} onChange={(event) => onChange({ ...draft, uid: event.target.value })} />
        <input className="settings-input" value={draft.primaryGroup} placeholder={t('remoteSettings.users.primaryGroupOptional', language)} onChange={(event) => onChange({ ...draft, primaryGroup: event.target.value })} />
        <input className="settings-input" value={draft.home} placeholder={t('remoteSettings.users.homeOptional', language)} onChange={(event) => onChange({ ...draft, home: event.target.value })} />
        <input className="settings-input" value={draft.shell} placeholder={t('remoteSettings.users.shell', language)} onChange={(event) => onChange({ ...draft, shell: event.target.value })} />
        <input className="settings-input" value={draft.supplementaryGroups} placeholder={t('remoteSettings.users.extraGroupsOptional', language)} onChange={(event) => onChange({ ...draft, supplementaryGroups: event.target.value })} />
      </div>
      <div className="user-manager-form-footer">
        <label className="settings-checkbox">
          <input type="checkbox" checked={draft.createHome} onChange={(event) => onChange({ ...draft, createHome: event.target.checked })} />
          <span>{t('remoteSettings.users.createHome', language)}</span>
        </label>
        <button type="button" className="settings-action-btn primary" onClick={onSubmit} disabled={running}>{t('remoteSettings.users.createUser', language)}</button>
      </div>
    </div>
  );
}

function UserEditForm({
  draft,
  language,
  running,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: EditUserDraft | null;
  language: ReturnType<typeof useCurrentAppLanguage>;
  running: boolean;
  onChange: (draft: EditUserDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  if (!draft) return null;

  return (
    <div className="settings-section user-manager-form-section">
      <h4>{t('remoteSettings.users.editUserTitle', language, { user: draft.username })}</h4>
      <div className="user-manager-form-grid">
        <input className="settings-input" value={draft.uid} placeholder={t('remoteSettings.users.uidOptional', language)} onChange={(event) => onChange({ ...draft, uid: event.target.value })} />
        <input className="settings-input" value={draft.primaryGroup} placeholder={t('remoteSettings.users.primaryGroupOptional', language)} onChange={(event) => onChange({ ...draft, primaryGroup: event.target.value })} />
        <input className="settings-input" value={draft.home} placeholder={t('remoteSettings.users.homeOptional', language)} onChange={(event) => onChange({ ...draft, home: event.target.value })} />
        <input className="settings-input" value={draft.shell} placeholder={t('remoteSettings.users.shell', language)} onChange={(event) => onChange({ ...draft, shell: event.target.value })} />
      </div>
      <div className="user-manager-form-footer">
        <label className="settings-checkbox">
          <input type="checkbox" checked={draft.moveHome} onChange={(event) => onChange({ ...draft, moveHome: event.target.checked })} />
          <span>{t('remoteSettings.users.moveHome', language)}</span>
        </label>
        <div className="settings-header-actions">
          <button type="button" className="settings-action-btn" onClick={onCancel} disabled={running}>{t('remoteSettings.common.cancel', language)}</button>
          <button type="button" className="settings-action-btn primary" onClick={onSubmit} disabled={running}>{t('remoteSettings.common.save', language)}</button>
        </div>
      </div>
    </div>
  );
}

function UserDetailBlock({
  detail,
  language,
}: {
  detail: RemoteUserDetail | null;
  language: ReturnType<typeof useCurrentAppLanguage>;
}) {
  if (!detail) return null;

  return (
    <div className="settings-section">
      <h4>{t('remoteSettings.users.detailTitle', language, { user: detail.username })}</h4>
      <div className="user-manager-detail-grid">
        <div>
          <span>{t('remoteSettings.users.extraGroups', language)}</span>
          <strong>{detail.supplementaryGroups.join(', ') || '-'}</strong>
        </div>
        <div>
          <span>{t('remoteSettings.users.sshKeys', language)}</span>
          <strong>{detail.sshKeysReadable ? String(detail.sshKeyCount ?? 0) : t('remoteSettings.users.unreadable', language)}</strong>
        </div>
        <div>
          <span>{t('remoteSettings.users.lastLogin', language)}</span>
          <strong>{detail.lastLogin || '-'}</strong>
        </div>
      </div>
      {detail.passwordAging ? <pre className="settings-output">{detail.passwordAging}</pre> : null}
    </div>
  );
}

function UsersView({
  addUserDraft,
  detail,
  editUserDraft,
  filteredUsers,
  language,
  query,
  running,
  selectedUser,
  setAddUserDraft,
  setQuery,
  onCreateUser,
  onDeleteUser,
  onEditUser,
  onLoadDetail,
  onPasswordAction,
  onSaveEdit,
  setEditUserDraft,
}: {
  addUserDraft: AddUserDraft;
  detail: RemoteUserDetail | null;
  editUserDraft: EditUserDraft | null;
  filteredUsers: RemoteUserRecord[];
  language: ReturnType<typeof useCurrentAppLanguage>;
  query: string;
  running: boolean;
  selectedUser: string;
  setAddUserDraft: (draft: AddUserDraft) => void;
  setQuery: (query: string) => void;
  onCreateUser: () => void;
  onDeleteUser: (user: RemoteUserRecord, deleteHome: boolean) => void;
  onEditUser: (user: RemoteUserRecord) => void;
  onLoadDetail: (user: RemoteUserRecord) => void;
  onPasswordAction: (user: RemoteUserRecord, action: 'lock' | 'unlock' | 'expire') => void;
  onSaveEdit: () => void;
  setEditUserDraft: (draft: EditUserDraft | null) => void;
}) {
  return (
    <>
      <UserAddForm draft={addUserDraft} language={language} running={running} onChange={setAddUserDraft} onSubmit={onCreateUser} />
      <div className="settings-section">
        <div className="user-manager-list-header">
          <h4>{t('remoteSettings.users.userList', language, { count: String(filteredUsers.length) })}</h4>
          <input className="settings-input" value={query} placeholder={t('remoteSettings.users.searchUsers', language)} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="user-manager-table-scroll">
          <table className="user-manager-table">
            <thead>
              <tr>
                <th>{t('remoteSettings.users.username', language)}</th>
                <th>UID</th>
                <th>GID</th>
                <th>{t('remoteSettings.users.primaryGroup', language)}</th>
                <th>{t('remoteSettings.users.home', language)}</th>
                <th>{t('remoteSettings.users.shell', language)}</th>
                <th>{t('remoteSettings.users.status', language)}</th>
                <th>{t('remoteSettings.users.actions', language)}</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.username} className={selectedUser === user.username ? 'selected' : ''} data-testid={`user-manager-row-${user.username}`} onClick={() => onLoadDetail(user)}>
                  <td><strong>{user.username}</strong>{user.isSystemUser ? <span>{t('remoteSettings.users.systemUser', language)}</span> : null}</td>
                  <td>{user.uid}</td>
                  <td>{user.gid}</td>
                  <td>{user.primaryGroup}</td>
                  <td title={user.home}>{user.home || '-'}</td>
                  <td title={user.shell}>{user.shell || '-'}</td>
                  <td><span className={`user-status-pill ${user.passwordStatus}`}>{getPasswordStatusLabel(user.passwordStatus, language)}</span></td>
                  <td>
                    <div className="user-manager-row-actions">
                      <button type="button" onClick={(event) => { event.stopPropagation(); onEditUser(user); }}>{t('remoteSettings.common.edit', language)}</button>
                      <button type="button" onClick={(event) => { event.stopPropagation(); onPasswordAction(user, user.passwordStatus === 'locked' ? 'unlock' : 'lock'); }}>
                        {user.passwordStatus === 'locked' ? t('remoteSettings.users.unlock', language) : t('remoteSettings.users.lock', language)}
                      </button>
                      <button type="button" onClick={(event) => { event.stopPropagation(); onPasswordAction(user, 'expire'); }}>{t('remoteSettings.users.forcePasswordChange', language)}</button>
                      <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); onDeleteUser(user, false); }}>{t('remoteSettings.common.remove', language)}</button>
                      <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); onDeleteUser(user, true); }}>{t('remoteSettings.users.deleteWithHomeShort', language)}</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!filteredUsers.length ? (
                <tr><td colSpan={8} className="user-manager-empty">{t('remoteSettings.users.noUsers', language)}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      <UserEditForm draft={editUserDraft} language={language} running={running} onChange={setEditUserDraft} onCancel={() => setEditUserDraft(null)} onSubmit={onSaveEdit} />
      <UserDetailBlock detail={detail} language={language} />
    </>
  );
}

function GroupsView({
  addGroupDraft,
  groups,
  language,
  memberGroup,
  memberUser,
  running,
  setAddGroupDraft,
  setMemberGroup,
  setMemberUser,
  onCreateGroup,
  onDeleteGroup,
  onMemberAction,
}: {
  addGroupDraft: AddGroupDraft;
  groups: RemoteGroupRecord[];
  language: ReturnType<typeof useCurrentAppLanguage>;
  memberGroup: string;
  memberUser: string;
  running: boolean;
  setAddGroupDraft: (draft: AddGroupDraft) => void;
  setMemberGroup: (group: string) => void;
  setMemberUser: (user: string) => void;
  onCreateGroup: () => void;
  onDeleteGroup: (group: RemoteGroupRecord) => void;
  onMemberAction: (action: 'add' | 'remove') => void;
}) {
  return (
    <>
      <div className="settings-section user-manager-form-section">
        <h4>{t('remoteSettings.users.addGroup', language)}</h4>
        <div className="settings-inline-form">
          <input className="settings-input" value={addGroupDraft.name} placeholder={t('remoteSettings.users.groupName', language)} onChange={(event) => setAddGroupDraft({ ...addGroupDraft, name: event.target.value })} />
          <input className="settings-input" value={addGroupDraft.gid} placeholder={t('remoteSettings.users.gidOptional', language)} onChange={(event) => setAddGroupDraft({ ...addGroupDraft, gid: event.target.value })} />
          <button type="button" className="settings-action-btn primary" onClick={onCreateGroup} disabled={running}>{t('remoteSettings.users.createGroup', language)}</button>
        </div>
      </div>
      <div className="settings-section user-manager-form-section">
        <h4>{t('remoteSettings.users.groupMembers', language)}</h4>
        <div className="settings-inline-form">
          <input className="settings-input" value={memberUser} placeholder={t('remoteSettings.users.username', language)} onChange={(event) => setMemberUser(event.target.value)} />
          <input className="settings-input" value={memberGroup} placeholder={t('remoteSettings.users.groupName', language)} onChange={(event) => setMemberGroup(event.target.value)} />
          <button type="button" className="settings-action-btn" onClick={() => onMemberAction('add')} disabled={running}>{t('remoteSettings.users.addMember', language)}</button>
          <button type="button" className="settings-action-btn danger" onClick={() => onMemberAction('remove')} disabled={running}>{t('remoteSettings.users.removeMember', language)}</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.users.groupList', language, { count: String(groups.length) })}</h4>
        <div className="user-manager-table-scroll">
          <table className="user-manager-table">
            <thead>
              <tr>
                <th>{t('remoteSettings.users.groupName', language)}</th>
                <th>GID</th>
                <th>{t('remoteSettings.users.members', language)}</th>
                <th>{t('remoteSettings.users.actions', language)}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.name}>
                  <td><strong>{group.name}</strong></td>
                  <td>{group.gid}</td>
                  <td>{group.members.join(', ') || '-'}</td>
                  <td><button type="button" className="settings-action-btn danger" onClick={() => onDeleteGroup(group)}>{t('remoteSettings.common.remove', language)}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function SettingsUserManagerPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [activeView, setActiveView] = useState<UserManagerView>('users');
  const [snapshot, setSnapshot] = useState<RemoteUserManagerSnapshot>(EMPTY_SNAPSHOT);
  const [query, setQuery] = useState('');
  const [addUserDraft, setAddUserDraft] = useState<AddUserDraft>(DEFAULT_ADD_USER_DRAFT);
  const [editUserDraft, setEditUserDraft] = useState<EditUserDraft | null>(null);
  const [addGroupDraft, setAddGroupDraft] = useState<AddGroupDraft>(DEFAULT_ADD_GROUP_DRAFT);
  const [memberUser, setMemberUser] = useState('');
  const [memberGroup, setMemberGroup] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [detail, setDetail] = useState<RemoteUserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);

  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return snapshot.users;
    return snapshot.users.filter((user) => [
      user.username,
      String(user.uid),
      String(user.gid),
      user.primaryGroup,
      user.home,
      user.shell,
      ...user.supplementaryGroups,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [query, snapshot.users]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await runCommand(USER_MANAGER_SNAPSHOT_COMMAND);
      if (result.code !== 0 && !result.stdout) {
        throw new Error(result.stderr || t('remoteSettings.users.loadFailed', language));
      }
      setSnapshot(parseUserManagerSnapshot(result.stdout));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [language, runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  const runPrivilegedCommand = useCallback(async (command: string, successMessage: string) => {
    setRunning(true);
    setError('');
    setSuccess('');
    try {
      const result = await runCommand(withLinuxPrivilege(`${command} 2>&1`));
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || t('remoteSettings.common.operationFailedRoot', language));
      }
      setSuccess(successMessage);
      await refresh();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      throw new Error(message);
    } finally {
      setRunning(false);
    }
  }, [language, refresh, runCommand]);

  const requestCommand = useCallback((config: Omit<SettingsConfirmDialogConfig, 'onConfirm'> & { command: string; successMessage: string }) => {
    setConfirmDialog({
      title: config.title,
      message: config.message,
      detail: config.detail,
      preview: config.preview ?? config.command,
      confirmLabel: config.confirmLabel,
      tone: config.tone,
      onConfirm: () => runPrivilegedCommand(config.command, config.successMessage),
    });
  }, [runPrivilegedCommand]);

  const createUser = () => {
    const invalidField = validateAddUserDraft(addUserDraft);
    if (invalidField) {
      setError(getValidationError(invalidField, language));
      return;
    }
    const command = buildAddUserCommand(addUserDraft);
    requestCommand({
      title: t('remoteSettings.users.createUserTitle', language),
      message: t('remoteSettings.users.createUserMessage', language, { user: addUserDraft.username.trim() }),
      detail: t('remoteSettings.users.privilegedDetail', language),
      confirmLabel: t('remoteSettings.users.createUser', language),
      command,
      successMessage: t('remoteSettings.users.userCreated', language, { user: addUserDraft.username.trim() }),
    });
  };

  const saveEditUser = () => {
    if (!editUserDraft) return;
    const invalidField = validateEditUserDraft(editUserDraft);
    if (invalidField) {
      setError(getValidationError(invalidField, language));
      return;
    }
    const command = buildEditUserCommand(editUserDraft);
    requestCommand({
      title: t('remoteSettings.users.saveUserTitle', language),
      message: t('remoteSettings.users.saveUserMessage', language, { user: editUserDraft.username }),
      detail: t('remoteSettings.users.privilegedDetail', language),
      confirmLabel: t('remoteSettings.common.save', language),
      command,
      successMessage: t('remoteSettings.users.userSaved', language, { user: editUserDraft.username }),
    });
  };

  const deleteUser = (user: RemoteUserRecord, deleteHome: boolean) => {
    requestCommand({
      title: t('remoteSettings.users.deleteUserTitle', language),
      message: t('remoteSettings.users.deleteUserMessage', language, { user: user.username }),
      detail: deleteHome ? t('remoteSettings.users.deleteUserWithHomeDetail', language) : t('remoteSettings.users.deleteUserDetail', language),
      confirmLabel: deleteHome ? t('remoteSettings.users.deleteUserWithHome', language) : t('remoteSettings.users.deleteUser', language),
      tone: 'danger',
      command: buildDeleteUserCommand(user.username, deleteHome),
      successMessage: t('remoteSettings.users.userDeleted', language, { user: user.username }),
    });
  };

  const passwordAction = (user: RemoteUserRecord, action: 'lock' | 'unlock' | 'expire') => {
    const command = buildUserPasswordCommand(user.username, action);
    const copy = getPasswordActionCopy(action, language, user.username);
    requestCommand({
      title: copy.title,
      message: copy.message,
      detail: t('remoteSettings.users.privilegedDetail', language),
      confirmLabel: copy.confirm,
      tone: action === 'lock' ? 'warning' : 'primary',
      command,
      successMessage: copy.done,
    });
  };

  const loadUserDetail = async (user: RemoteUserRecord) => {
    setSelectedUser(user.username);
    setDetail(null);
    setError('');
    try {
      const result = await runCommand(withLinuxPrivilege(buildUserDetailCommand(user.username, user.home)));
      setDetail(parseUserDetail(user.username, result.stdout));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const createGroup = () => {
    const invalidField = validateAddGroupDraft(addGroupDraft);
    if (invalidField) {
      setError(getValidationError(invalidField, language));
      return;
    }
    requestCommand({
      title: t('remoteSettings.users.createGroupTitle', language),
      message: t('remoteSettings.users.createGroupMessage', language, { group: addGroupDraft.name.trim() }),
      detail: t('remoteSettings.users.privilegedDetail', language),
      confirmLabel: t('remoteSettings.users.createGroup', language),
      command: buildAddGroupCommand(addGroupDraft),
      successMessage: t('remoteSettings.users.groupCreated', language, { group: addGroupDraft.name.trim() }),
    });
  };

  const deleteGroup = (group: RemoteGroupRecord) => {
    requestCommand({
      title: t('remoteSettings.users.deleteGroupTitle', language),
      message: t('remoteSettings.users.deleteGroupMessage', language, { group: group.name }),
      detail: t('remoteSettings.users.deleteGroupDetail', language),
      confirmLabel: t('remoteSettings.users.deleteGroup', language),
      tone: 'danger',
      command: buildDeleteGroupCommand(group.name),
      successMessage: t('remoteSettings.users.groupDeleted', language, { group: group.name }),
    });
  };

  const groupMemberAction = (action: 'add' | 'remove') => {
    if (!isSafeAccountName(memberUser) || !isSafeAccountName(memberGroup)) {
      setError(t('remoteSettings.users.validation.member', language));
      return;
    }
    requestCommand({
      title: action === 'add' ? t('remoteSettings.users.addMemberTitle', language) : t('remoteSettings.users.removeMemberTitle', language),
      message: action === 'add'
        ? t('remoteSettings.users.addMemberMessage', language, { user: memberUser.trim(), group: memberGroup.trim() })
        : t('remoteSettings.users.removeMemberMessage', language, { user: memberUser.trim(), group: memberGroup.trim() }),
      detail: t('remoteSettings.users.privilegedDetail', language),
      confirmLabel: action === 'add' ? t('remoteSettings.users.addMember', language) : t('remoteSettings.users.removeMember', language),
      command: buildGroupMemberCommand(memberUser, memberGroup, action),
      successMessage: action === 'add'
        ? t('remoteSettings.users.memberAdded', language, { user: memberUser.trim(), group: memberGroup.trim() })
        : t('remoteSettings.users.memberRemoved', language, { user: memberUser.trim(), group: memberGroup.trim() }),
    });
  };

  return (
    <div className="settings-panel-content user-manager-panel">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.users.title', language)}</h3>
          <p>{t('remoteSettings.users.description', language)}</p>
        </div>
        <div className="settings-header-actions">
          <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading || running}>
            {loading ? t('remoteSettings.common.loading', language) : t('remoteSettings.common.refresh', language)}
          </button>
        </div>
      </div>

      {error ? <DismissibleAlert className="error-banner" source="RemoteSettings" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {success ? <DismissibleAlert className="settings-success-banner" onDismiss={() => setSuccess('')}>{success}</DismissibleAlert> : null}

      <UserManagerViewTabs activeView={activeView} language={language} onChange={setActiveView} />

      {activeView === 'users' ? (
        <UsersView
          addUserDraft={addUserDraft}
          detail={detail}
          editUserDraft={editUserDraft}
          filteredUsers={filteredUsers}
          language={language}
          query={query}
          running={running}
          selectedUser={selectedUser}
          setAddUserDraft={setAddUserDraft}
          setQuery={setQuery}
          onCreateUser={createUser}
          onDeleteUser={deleteUser}
          onEditUser={(user) => setEditUserDraft(createEditDraftFromUser(user))}
          onLoadDetail={(user) => void loadUserDetail(user)}
          onPasswordAction={passwordAction}
          onSaveEdit={saveEditUser}
          setEditUserDraft={setEditUserDraft}
        />
      ) : null}

      {activeView === 'groups' ? (
        <GroupsView
          addGroupDraft={addGroupDraft}
          groups={snapshot.groups}
          language={language}
          memberGroup={memberGroup}
          memberUser={memberUser}
          running={running}
          setAddGroupDraft={setAddGroupDraft}
          setMemberGroup={setMemberGroup}
          setMemberUser={setMemberUser}
          onCreateGroup={createGroup}
          onDeleteGroup={deleteGroup}
          onMemberAction={groupMemberAction}
        />
      ) : null}

      {activeView === 'sudoers' ? (
        <div className="settings-section">
          <h4>{t('remoteSettings.users.sudoersOverview', language)}</h4>
          {snapshot.sudoersLines.length ? (
            <SettingsCommandPreview label={t('remoteSettings.users.sudoersLines', language)} content={snapshot.sudoersLines.join('\n')} />
          ) : (
            <p className="settings-hint">{t('remoteSettings.users.noSudoers', language)}</p>
          )}
        </div>
      ) : null}

      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}
