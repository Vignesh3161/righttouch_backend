import mongoose from "mongoose";

/**
 * 🗄 MONGODB TRANSACTION READINESS (Stage 6)
 *
 * Every financial mutation in this codebase (settlement credits, withdrawal
 * reserve moves, mark-paid finalization, payout settle/revert paths) commits
 * inside a multi-document transaction and therefore REQUIRES a replica set
 * (or sharded cluster). The standalone fallback in Utils/settlement.js is
 * explicitly non-atomic and dev-only.
 *
 * These helpers are read-only (a single `hello` command, no writes):
 * - `checkTransactionSupport()` reports topology support.
 * - `enforceTransactionSupport()` fails closed in production (process exit,
 *   same precedent as secret validation) and warns elsewhere. Test setup
 *   (in-memory replica set) is unaffected.
 */
export const checkTransactionSupport = async (conn = mongoose.connection) => {
  try {
    const admin = conn?.db?.admin?.();
    if (!admin) return { supported: false, setName: null, reason: "no_db_connection" };
    const hello = await admin.command({ hello: 1 });
    const setName = hello?.setName || null;
    if (setName) return { supported: true, setName, reason: "replica_set" };
    return { supported: false, setName: null, reason: "standalone_topology" };
  } catch (err) {
    return { supported: false, setName: null, reason: `check_failed:${err?.message || err}` };
  }
};

export const enforceTransactionSupport = async (conn = mongoose.connection) => {
  const check = await checkTransactionSupport(conn);
  if (check.supported) {
    console.log(`✅ MongoDB transactions supported (replica set "${check.setName}") — financial mutations are atomic.`);
    return true;
  }
  const msg =
    `❌ MongoDB transactions NOT supported (${check.reason}). ` +
    `All financial mutations require a replica set; standalone mode is non-atomic.`;
  if (process.env.NODE_ENV === "production") {
    console.error(`${msg} Refusing to start financial services in production.`);
    process.exit(1);
    return false;
  }
  console.warn(`${msg} Continuing in non-production for local development only.`);
  return false;
};
