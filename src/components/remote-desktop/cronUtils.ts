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
  if (line.kind !== 'task') return '非任务行';

  const parts: string[] = [];
  if (line.minute === '*' && line.hour === '*') parts.push('每分钟');
  else if (line.minute !== '*' && line.hour === '*') parts.push(`每小时第 ${line.minute} 分钟`);
  else if (line.minute !== '*' && line.hour !== '*') parts.push(`每天 ${line.hour}:${line.minute.padStart(2, '0')}`);
  else parts.push('自定义时间');

  if (line.dayOfWeek !== '*') parts.push(`星期 ${line.dayOfWeek}`);
  if (line.dayOfMonth !== '*') parts.push(`每月 ${line.dayOfMonth} 日`);
  if (line.month !== '*') parts.push(`${line.month} 月`);

  return parts.join('，');
}

export function validateCronTask(line: CronLine) {
  if (line.kind !== 'task') return '';

  const fields = [line.minute, line.hour, line.dayOfMonth, line.month, line.dayOfWeek];
  if (fields.some((field) => !field.trim() || /[\r\n]/.test(field))) {
    return 'Cron 时间字段无效。';
  }

  if (!line.command.trim()) {
    return '请输入任务命令。';
  }

  return '';
}
