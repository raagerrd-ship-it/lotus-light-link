/**
 * Thin re-export shim — avoids circular dependency between protocol and connection.
 * Modules that need resetLastSent import from protocol.ts directly.
 */
export { resetLastSent } from './protocol.js';
