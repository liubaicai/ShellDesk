import { tCurrent } from '../../i18n';
export type CronLineKind = 'task' | 'comment' | 'blank';

export interface CronLine {
  id: string;
  kind: CronLineKind;
  enabled: boolean;
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
  command: string;
  raw: string;
}

function createCronId(index: number) {
  return `cron-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createEmptyCronTask(): CronLine {
  return {
    id: createCronId(0),
    kind: 'task',
    enabled: true,
    minute: '*',
    hour: '*',
    dayOfMonth: '*',
    month: '*',
    dayOfWeek: '*',
    command: '',
    raw: '',
  };
}

export function parseCronText(text: string): CronLine[] {
  return text.split(/\r?\n/).map((raw, index) => {
    const trimmedLine = raw.trim();

    if (!trimmedLine) {
      return {
        ...createEmptyCronTask(),
        id: createCronId(index),
        kind: 'blank',
        enabled: false,
        raw,
      };
    }

    const disabledMatch = trimmedLine.match(/^#\s*((?:\S+\s+){5}.+)$/);
    const taskText = disabledMatch ? disabledMatch[1].trim() : trimmedLine;
    const parts = taskText.split(/\s+/);

    if (parts.length >= 6 && (!trimmedLine.startsWith('#') || disabledMatch)) {
      return {
        id: createCronId(index),
        kind: 'task',
        enabled: !disabledMatch,
        minute: parts[0],
        hour: parts[1],
        dayOfMonth: parts[2],
        month: parts[3],
        dayOfWeek: parts[4],
        command: parts.slice(5).join(' '),
        raw,
      };
    }

    return {
      ...createEmptyCronTask(),
      id: createCronId(index),
      kind: 'comment',
      enabled: false,
      raw,
    };
  });
}

export function serializeCronLines(lines: CronLine[]) {
  return lines.map((line) => {
    if (line.kind === 'blank') return '';
    if (line.kind === 'comment') return line.raw;

    const task = `${line.minute || '*'} ${line.hour || '*'} ${line.dayOfMonth || '*'} ${line.month || '*'} ${line.dayOfWeek || '*'} ${line.command}`.trim();
    return line.enabled ? task : `# ${task}`;
  }).join('\n').replace(/\s+$/, '');
}

export function describeCronExpression(line: CronLine) {
  if (line.kind !== 'task') return tCurrent('auto.cronUtils.1cvk78j');

  const parts: string[] = [];
  if (line.minute === '*' && line.hour === '*') parts.push(tCurrent('auto.cronUtils.wjj7o5'));
  else if (line.minute !== '*' && line.hour === '*') parts.push(tCurrent('auto.cronUtils.1lrwk1h', { value0: line.minute }));
  else if (line.minute !== '*' && line.hour !== '*') parts.push(tCurrent('auto.cronUtils.9shvto', { value0: line.hour, value1: line.minute.padStart(2, '0') }));
  else parts.push(tCurrent('auto.cronUtils.wizom'));

  if (line.dayOfWeek !== '*') parts.push(tCurrent('auto.cronUtils.10wpsmw', { value0: line.dayOfWeek }));
  if (line.dayOfMonth !== '*') parts.push(tCurrent('auto.cronUtils.14l2nsc', { value0: line.dayOfMonth }));
  if (line.month !== '*') parts.push(tCurrent('auto.cronUtils.sc58no', { value0: line.month }));

  return parts.join('，');
}

export function validateCronTask(line: CronLine) {
  if (line.kind !== 'task') return '';

  const fields = [line.minute, line.hour, line.dayOfMonth, line.month, line.dayOfWeek];
  if (fields.some((field) => !field.trim() || /[\r\n]/.test(field))) {
    return tCurrent('auto.cronUtils.14jtkj1');
  }

  if (!line.command.trim()) {
    return tCurrent('auto.cronUtils.11d9nmb');
  }

  return '';
}
