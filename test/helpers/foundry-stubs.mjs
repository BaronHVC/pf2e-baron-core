// Stand-ins for the Foundry/PF2e globals the library reads at call time. They
// live only in the tests: the library itself must never define or touch them
// at import.

/**
 * Sets globals for the duration of a test; returns a function that restores
 * whatever was there before (including "not defined").
 * @param {Record<string, *>} values
 */
export function setGlobals(values) {
  const saved = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return () => {
    for (const k of Object.keys(values)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };
}

/**
 * A `game` object with just the surfaces the helpers use.
 * - i18n.localize returns the key unchanged when it has no translation, as
 *   Foundry does.
 * - settings.get throws for an unregistered setting, as Foundry does, and
 *   records every read in settings.calls.
 */
export function makeGame({
  translations = {},
  lang = "en",
  user = { id: "u1", isGM: false },
  users,
  settings = {},
  packs = {},
  pf2e
} = {}) {
  const calls = [];
  return {
    i18n: {
      lang,
      localize: (key) => (Object.hasOwn(translations, key) ? translations[key] : key)
    },
    user,
    users,
    settings: {
      calls,
      get(namespace, key) {
        calls.push([namespace, key]);
        const id = `${namespace}.${key}`;
        if (!Object.hasOwn(settings, id)) throw new Error(`"${id}" is not a registered game setting`);
        return settings[id];
      }
    },
    packs: { get: (id) => packs[id] },
    pf2e
  };
}

/**
 * A compendium pack whose getIndex records its calls and resolves (or
 * rejects) with the given value.
 */
export function makePack(result, { reject = false } = {}) {
  const pack = {
    calls: [],
    getIndex(options) {
      pack.calls.push(options);
      return reject ? Promise.reject(result) : Promise.resolve(result);
    }
  };
  return pack;
}

/** game.pf2e with a ConditionManager that knows the given conditions. */
export function makePf2e(conditions) {
  return {
    ConditionManager: {
      conditions: new Map(
        Object.entries(conditions).map(([slug, isValued]) => [slug, { system: { value: { isValued } } }])
      )
    }
  };
}

/** Lets pending zero-delay timers and microtasks run. */
export function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
