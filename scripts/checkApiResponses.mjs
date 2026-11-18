import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TARGET_DIRS = ["Controllers", "Routes", "Middleware", "Utils"];
const TARGET_FILES = ["index.js"];
const SKIP_FILES = new Set(["Utils/apiResponse.js"]);

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "success",
  "message",
  "result",
  "code",
  "details",
  "errors",
  "fieldErrors",
  "meta",
  "pagination",
  "diagnostic",
  "total",
  "page",
  "limit",
  "totalPages",
  "totalCount",
  "hasNext",
  "hasPrevious",
]);

// Temporary compatibility bridge. Remove entries as clients migrate.
const LEGACY_MIRROR_ALLOWLIST = new Set([
  "Controllers/adminNotificationController.js:getAdminUnreadCounts",
  "Controllers/adminNotificationController.js:markAdminItemRead",
  "Controllers/adminServiceAvailabilityController.js:getServiceZoneDetail",
  "Controllers/adminTechnicianZoneController.js:getTechnicianZonePermissions",
  "Controllers/bookAgainController.js:rebookService",
  "Controllers/notificationController.js:listNotifications",
  "Controllers/notificationController.js:unreadCount",
  "Controllers/ratingController.js:userRating",
  "Controllers/ratingController.js:updateRatingController",
  "Controllers/ratingController.js:deleteRatingController",
  "Controllers/ratingController.js:adminUpdateRatingController",
  "Controllers/ratingController.js:adminDeleteRatingController",
  "Controllers/serviceBookController.js:storeBookingSchedule",
  "Controllers/serviceBookController.js:acceptCancelledJob",
  "Controllers/serviceController.js:getAllServices",
  "Controllers/technician.js:updateTechnician",
  "Controllers/technicianBroadcastController.js:respondToJob",
  "Controllers/technicianWalletController.js:getTechnicianWallet",
  "Controllers/technicianWalletController.js:getWithdrawalReceipt",
]);

const COMMENT_WINDOW_LINES = 5;

const toPosix = (value) => value.split(path.sep).join("/");

const walkFiles = (dir, files = []) => {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, files);
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
};

const skipQuoted = (source, index) => {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) return i + 1;
    i += 1;
  }
  return i;
};

const skipBlockComment = (source, index) => {
  const end = source.indexOf("*/", index + 2);
  return end === -1 ? source.length : end + 2;
};

const skipLineComment = (source, index) => {
  const end = source.indexOf("\n", index + 2);
  return end === -1 ? source.length : end + 1;
};

// index is the character immediately after the opening brace.
const skipBraced = (source, index) => {
  let depth = 1;
  let i = index;
  while (i < source.length) {
    const char = source[i];
    if (char === '"' || char === "'") {
      i = skipQuoted(source, i);
      continue;
    }
    if (char === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
};

const skipTemplate = (source, index) => {
  let i = index + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "`") return i + 1;
    if (char === "$" && source[i + 1] === "{") {
      i = skipBraced(source, i + 2);
      continue;
    }
    i += 1;
  }
  return i;
};

const splitTopLevel = (source) => {
  const parts = [];
  let start = 0;
  let i = 0;
  const stack = [];

  while (i < source.length) {
    const char = source[i];
    if (char === '"' || char === "'") {
      i = skipQuoted(source, i);
      continue;
    }
    if (char === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i);
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      stack.push(char);
      i += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      stack.pop();
      i += 1;
      continue;
    }
    if (char === "," && stack.length === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }

  parts.push(source.slice(start));
  return parts;
};

const parseObjectShape = (content) => {
  const keys = [];
  const values = new Map();
  let hasSpread = false;
  let hasComputedKey = false;

  for (const rawPart of splitTopLevel(content)) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.startsWith("...")) {
      hasSpread = true;
      continue;
    }
    if (part.startsWith("[")) {
      hasComputedKey = true;
      continue;
    }

    const match = part.match(
      /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(?::|$)/
    );
    if (!match) continue;
    const key = match[1] || match[2] || match[3];
    keys.push(key);
    const colonIndex = part.indexOf(":");
    values.set(
      key,
      colonIndex === -1 ? "" : part.slice(colonIndex + 1).trim()
    );
  }

  return { keys, values, hasSpread, hasComputedKey };
};

const lineAt = (source, index) =>
  source.slice(0, index).split("\n").length;

const hasComment = (source, index, pattern) => {
  const line = lineAt(source, index);
  const lines = source.split("\n");
  const start = Math.max(0, line - COMMENT_WINDOW_LINES - 1);
  const end = Math.min(lines.length, line);
  return pattern.test(lines.slice(start, end).join("\n"));
};

const nearestExportedFunction = (source, index) => {
  const before = source.slice(0, index);
  const matcher =
    /(?:^|\n)\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=|(?:^|\n)\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:^|\n)\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g;
  let match;
  let name = null;
  while ((match = matcher.exec(before))) {
    name = match[1] || match[2] || match[3] || name;
  }
  return name;
};

const checkFile = (rootDir, filePath, violations) => {
  const relativePath = toPosix(path.relative(rootDir, filePath));
  if (SKIP_FILES.has(relativePath)) return;

  const source = fs.readFileSync(filePath, "utf8");
  const isControllerRouteOrMiddleware =
    relativePath.startsWith("Controllers/") ||
    relativePath.startsWith("Routes/") ||
    relativePath.startsWith("Middleware/");

  const jsonCall =
    /\bres\s*\.\s*(?:status\s*\([^)]*\)\s*\.\s*)?json\s*\(/g;
  let match;

  while ((match = jsonCall.exec(source))) {
    const line = lineAt(source, match.index);
    let index = match.index + match[0].length;
    while (/\s/.test(source[index])) index += 1;

    if (source[index] !== "{") {
      violations.push({
        file: relativePath,
        line,
        message:
          "res.json() argument is not an object literal; wrap it with ok()/fail() or verify the envelope manually.",
      });
      continue;
    }

    const end = skipBraced(source, index + 1);
    const content = source.slice(index + 1, end - 1);
    const shape = parseObjectShape(content);

    if (!shape.keys.includes("success")) {
      violations.push({
        file: relativePath,
        line,
        message: "Missing top-level success.",
      });
    }

    for (const key of shape.keys) {
      if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
        violations.push({
          file: relativePath,
          line,
          message: `Disallowed top-level key: ${key}. Move business data under result or use an approved legacy mirror.`,
        });
      }
    }

    if (shape.hasComputedKey) {
      violations.push({
        file: relativePath,
        line,
        message: "Computed top-level keys are not allowed in responses.",
      });
    }

    if (
      shape.hasSpread &&
      !hasComment(source, match.index, /api-envelope-allow-spread/)
    ) {
      violations.push({
        file: relativePath,
        line,
        message:
          "Top-level spread is not allowed; write explicit envelope fields or use an approved legacy mirror.",
      });
    }

    const successValue = shape.values.get("success");
    if (
      successValue !== undefined &&
      successValue !== "true" &&
      successValue !== "false"
    ) {
      if (hasComment(source, match.index, /api-envelope-allow-dynamic-success/)) continue;
      violations.push({
        file: relativePath,
        line,
        message: "success must be a boolean literal (true or false).",
      });
    }
  }

  const legacyCall = /\b(okLegacy|failLegacy)\s*\(/g;
  while ((match = legacyCall.exec(source))) {
    const line = lineAt(source, match.index);
    const fnName = nearestExportedFunction(source, match.index);
    if (!fnName) {
      violations.push({
        file: relativePath,
        line,
        message:
          "Legacy mirror call is not inside an exported controller function.",
      });
      continue;
    }
    const allowKey = `${relativePath}:${fnName}`;
    if (!LEGACY_MIRROR_ALLOWLIST.has(allowKey)) {
      violations.push({
        file: relativePath,
        line,
        message: `Unapproved legacy mirror in ${fnName}. Add it to LEGACY_MIRROR_ALLOWLIST with a migration note or remove it.`,
      });
    }
    if (!hasComment(source, match.index, /TODO\(api-contract\)/)) {
      violations.push({
        file: relativePath,
        line,
        message:
          "Legacy mirror is missing a TODO(api-contract) removal comment.",
      });
    }
  }

  const sendCall = /\bres\s*\.\s*(?:sendStatus|send)\s*\(/g;
  while ((match = sendCall.exec(source))) {
    if (relativePath.endsWith("apiResponse.js")) continue;
    if (!hasComment(source, match.index, /api-envelope-exception/)) {
      violations.push({
        file: relativePath,
        line: lineAt(source, match.index),
        message:
          "Non-JSON response is not annotated with // api-envelope-exception.",
      });
    }
  }

  if (isControllerRouteOrMiddleware) {
    const localHelper = /(?:^|\n)\s*(?:const|let|var)\s+(ok|fail)\s*=/g;
    while ((match = localHelper.exec(source))) {
      violations.push({
        file: relativePath,
        line: lineAt(source, match.index),
        message: `Local ${match[1]} helper found; import ok/fail from Utils/apiResponse.js instead.`,
      });
    }
  }
};

export const checkApiResponses = ({ rootDir = process.cwd() } = {}) => {
  const files = [...TARGET_FILES.map((file) => path.join(rootDir, file))];
  for (const dir of TARGET_DIRS) {
    walkFiles(path.join(rootDir, dir), files);
  }

  const violations = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    checkFile(rootDir, file, violations);
  }

  return violations;
};

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const rootDir = process.cwd();
  const violations = checkApiResponses({ rootDir });
  if (violations.length) {
    console.error(`API response contract violations: ${violations.length}`);
    for (const violation of violations) {
      console.error(`- ${violation.file}:${violation.line} ${violation.message}`);
    }
    process.exit(1);
  }
  console.log("API response contract check passed.");
}
