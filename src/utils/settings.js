const SETTINGS_FIELD_VALUES = Object.freeze({
  defaultDiscount: (value) => Number.isInteger(value) && value >= 1 && value <= 99,
  historyRetentionDays: (value) => ['30', '90', '365', 'forever'].includes(value),
  dashboardSort: (value) => ['recent', 'priceAsc', 'priceDesc', 'discountDesc'].includes(value),
  dashboardFilter: (value) => ['all', 'drops', 'priority', 'outOfStock', 'targetReached', 'unchecked'].includes(value)
});

export const OPTIONS_SETTINGS_FIELDS = Object.freeze([
  'defaultDiscount',
  'historyRetentionDays'
]);

export const DASHBOARD_SETTINGS_FIELDS = Object.freeze([
  'dashboardSort',
  'dashboardFilter'
]);

export function validateSettingsPatch(message, allowedFields) {
  const set = message?.set ?? {};
  const remove = message?.remove ?? [];
  if (!set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(remove)) {
    throw new Error('Invalid settings patch.');
  }

  const allowed = new Set(allowedFields);
  const setKeys = Object.keys(set);
  if (setKeys.length === 0 && remove.length === 0) {
    throw new Error('Settings patch is empty.');
  }

  for (const key of setKeys) {
    if (!allowed.has(key) || !SETTINGS_FIELD_VALUES[key]?.(set[key])) {
      throw new Error(`Invalid settings field: ${key}.`);
    }
  }

  const seenRemovals = new Set();
  for (const key of remove) {
    if (typeof key !== 'string' || !allowed.has(key) || seenRemovals.has(key) || Object.hasOwn(set, key)) {
      throw new Error('Invalid settings removal.');
    }
    seenRemovals.add(key);
  }

  return { set, remove: [...seenRemovals] };
}

export function applySettingsPatch(settings, patch) {
  const nextSettings = {
    ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}),
    ...patch.set
  };
  for (const key of patch.remove) delete nextSettings[key];
  return nextSettings;
}
