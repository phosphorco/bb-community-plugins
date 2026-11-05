// Data-only invalidation names; importing these does not construct RPC schemas.
export const TEMPLATES_CHANGED = 'new-thread-templates:changed';

export const TEMPLATES_DEFINITIONS_CHANGED='new-thread-templates:definitions-changed';
export const TEMPLATES_CATALOG_CHANGED='new-thread-templates:catalog-changed';
export const TEMPLATES_JOURNAL_CHANGED='new-thread-templates:journal-changed';
export const TEMPLATES_CONFIG_EVENTS=['project:changed','environment:changed','host:changed','system:config-changed','system:changed'] as const;
