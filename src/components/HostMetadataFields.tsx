import { useMemo } from 'react';
import { Check } from 'lucide-react';

import {
  formatTags,
  type Host,
  type HostGroup,
  parseTags,
  ungroupedKey,
} from '../appHostModel';
import { t, type AppLanguage } from '../i18n';

export function useHostMetadataOptions(hostGroups: HostGroup[], hosts: Host[], appLocale: string) {
  const hostGroupOptions = useMemo(
    () => hostGroups.filter((group) => group.key !== ungroupedKey).map((group) => group.name),
    [hostGroups],
  );
  const hostTagOptions = useMemo(() => {
    const tags = new Set<string>();

    for (const host of hosts) {
      for (const tag of host.tags) {
        const normalizedTag = tag.trim();

        if (normalizedTag) {
          tags.add(normalizedTag);
        }
      }
    }

    return Array.from(tags).sort((left, right) => left.localeCompare(right, appLocale));
  }, [appLocale, hosts]);

  return { hostGroupOptions, hostTagOptions };
}

interface HostMetadataFieldsProps {
  appLanguage: AppLanguage;
  group: string;
  tags: string;
  groupOptions: string[];
  tagOptions: string[];
  onChange: (field: 'group' | 'tags', value: string) => void;
}

export default function HostMetadataFields({
  appLanguage,
  group,
  tags,
  groupOptions,
  tagOptions,
  onChange,
}: HostMetadataFieldsProps) {
  const selectedTags = useMemo(() => parseTags(tags), [tags]);
  const selectedTagKeys = useMemo(
    () => new Set(selectedTags.map((tag) => tag.toLocaleLowerCase())),
    [selectedTags],
  );

  const addTag = (tag: string) => {
    if (selectedTagKeys.has(tag.toLocaleLowerCase())) {
      return;
    }

    onChange('tags', formatTags([...selectedTags, tag].slice(0, 8)));
  };

  return (
    <>
      <div className="field">
        <span>{t('app.host.field.group', appLanguage)}</span>
        <input
          list="host-group-options"
          aria-label={t('app.host.field.group', appLanguage)}
          value={group}
          onChange={(event) => onChange('group', event.target.value)}
          placeholder="AWS / Production / Lab"
        />
        <datalist id="host-group-options">
          {groupOptions.map((option) => <option key={option} value={option} />)}
        </datalist>
        {groupOptions.length ? (
          <div className="host-field-suggestions" aria-label={appLanguage === 'zh-CN' ? '已有分组' : 'Existing groups'}>
            {groupOptions.map((option) => (
              <button
                key={option}
                type="button"
                className={group === option ? 'active' : ''}
                onClick={() => onChange('group', option)}
              >
                {group === option ? <Check aria-hidden="true" /> : null}
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="field">
        <span>{t('app.host.field.tags', appLanguage)}</span>
        <input
          aria-label={t('app.host.field.tags', appLanguage)}
          value={tags}
          onChange={(event) => onChange('tags', event.target.value)}
          placeholder="linux, prod, db"
        />
        {tagOptions.length ? (
          <div className="host-field-suggestions" aria-label={appLanguage === 'zh-CN' ? '已有标签' : 'Existing tags'}>
            {tagOptions.map((tag) => {
              const isSelected = selectedTagKeys.has(tag.toLocaleLowerCase());

              return (
                <button
                  key={tag}
                  type="button"
                  className={isSelected ? 'active' : ''}
                  disabled={isSelected || selectedTags.length >= 8}
                  onClick={() => addTag(tag)}
                >
                  {isSelected ? <Check aria-hidden="true" /> : null}
                  {tag}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}
