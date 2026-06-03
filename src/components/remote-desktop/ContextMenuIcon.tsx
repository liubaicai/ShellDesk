export type ContextMenuIconName =
  | 'archive'
  | 'copy'
  | 'database'
  | 'desktop'
  | 'download'
  | 'info'
  | 'move-desktop'
  | 'new-file'
  | 'new-folder'
  | 'notepad'
  | 'open'
  | 'refresh'
  | 'rename'
  | 'sort'
  | 'terminal'
  | 'trash'
  | 'upload';

interface ContextMenuIconProps {
  name: ContextMenuIconName;
}

function ContextMenuIcon({ name }: ContextMenuIconProps) {
  return (
    <svg className="context-menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'archive' ? (
        <>
          <path d="M5.25 8.5h13.5" />
          <path d="M6.75 8.5v10.25h10.5V8.5" />
          <path d="M7.75 5.25h8.5l1.5 3.25H6.25Z" />
          <path d="M10 12h4" />
        </>
      ) : null}
      {name === 'copy' ? (
        <>
          <path d="M8.25 8.25h9.5v9.5h-9.5Z" />
          <path d="M5.25 14.75V5.25h9.5" />
        </>
      ) : null}
      {name === 'database' ? (
        <>
          <ellipse cx="12" cy="6.5" rx="6.25" ry="2.75" />
          <path d="M5.75 6.5v10c0 1.5 2.8 2.75 6.25 2.75s6.25-1.25 6.25-2.75v-10" />
          <path d="M5.75 11.5c0 1.5 2.8 2.75 6.25 2.75s6.25-1.25 6.25-2.75" />
        </>
      ) : null}
      {name === 'desktop' ? (
        <>
          <path d="M4.5 5.75h15v10.5h-15Z" />
          <path d="M9.25 19.25h5.5" />
          <path d="M12 16.25v3" />
        </>
      ) : null}
      {name === 'download' ? (
        <>
          <path d="M12 4.75v10" />
          <path d="m7.25 10 4.75 4.75L16.75 10" />
          <path d="M5.5 18.75h13" />
        </>
      ) : null}
      {name === 'info' ? (
        <>
          <circle cx="12" cy="12" r="7.25" />
          <path d="M12 10.75v4.75" />
          <path d="M12 7.75h.01" />
        </>
      ) : null}
      {name === 'move-desktop' ? (
        <>
          <path d="M4.5 5.75h15v10.5h-15Z" />
          <path d="M9.25 19.25h5.5" />
          <path d="M12 16.25v3" />
          <path d="M9.25 11.25h6.5" />
          <path d="m13.75 9.25 2 2-2 2" />
        </>
      ) : null}
      {name === 'new-file' ? (
        <>
          <path d="M7.25 4.75h6.25l3.25 3.25v11.25H7.25Z" />
          <path d="M13.5 4.75V8h3.25" />
          <path d="M12 11.25v5" />
          <path d="M9.5 13.75h5" />
        </>
      ) : null}
      {name === 'new-folder' ? (
        <>
          <path d="M4.5 7.25h6l1.5 2h7.5v9H4.5Z" />
          <path d="M12 11.75v4.5" />
          <path d="M9.75 14h4.5" />
        </>
      ) : null}
      {name === 'notepad' ? (
        <>
          <path d="M7 5.25h10v13.5H7Z" />
          <path d="M9.5 8.25h5" />
          <path d="M9.5 11h5" />
          <path d="M9.5 13.75h3" />
        </>
      ) : null}
      {name === 'open' ? (
        <>
          <path d="M4.5 8h5.75l1.5 2h7.75v8.25h-15Z" />
          <path d="M5.75 6.25h5.25l1.25 1.75" />
        </>
      ) : null}
      {name === 'refresh' ? (
        <>
          <path d="M17.25 8.75A6.25 6.25 0 0 0 6 9.5" />
          <path d="M17.25 5.5v3.25H14" />
          <path d="M6.75 15.25A6.25 6.25 0 0 0 18 14.5" />
          <path d="M6.75 18.5v-3.25H10" />
        </>
      ) : null}
      {name === 'rename' ? (
        <>
          <path d="M5.25 17.75h13.5" />
          <path d="m8 14.5 7.8-7.8 1.7 1.7-7.8 7.8-2.2.5Z" />
        </>
      ) : null}
      {name === 'sort' ? (
        <>
          <path d="M7.5 6.25h9" />
          <path d="M7.5 12h6.5" />
          <path d="M7.5 17.75h3.5" />
        </>
      ) : null}
      {name === 'terminal' ? (
        <>
          <path d="M4.75 6.25h14.5v12.5H4.75Z" />
          <path d="m8 10 2.25 2L8 14" />
          <path d="M12 14h3.5" />
        </>
      ) : null}
      {name === 'trash' ? (
        <>
          <path d="M5.75 7.5h12.5" />
          <path d="M9.25 7.5V5.25h5.5V7.5" />
          <path d="M7.25 7.5 8 18.75h8l.75-11.25" />
          <path d="M10.5 10.75v5" />
          <path d="M14.5 10.75v5" />
        </>
      ) : null}
      {name === 'upload' ? (
        <>
          <path d="M12 14.75v-10" />
          <path d="M7.25 9.5 12 4.75l4.75 4.75" />
          <path d="M5.5 18.75h13" />
        </>
      ) : null}
    </svg>
  );
}

export default ContextMenuIcon;
