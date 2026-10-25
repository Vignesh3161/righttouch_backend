const candidateId = (candidate) => {
  if (!candidate) return null;
  if (typeof candidate === "object") {
    return candidate._id ?? candidate.technicianId ?? candidate.id ?? null;
  }
  return candidate;
};

export const mergeTechnicianCandidateIds = (...sources) => {
  const ids = new Set();
  for (const source of sources) {
    if (!source) continue;
    for (const candidate of source) {
      const id = candidateId(candidate);
      if (id === null || id === undefined || id === "") continue;
      ids.add(String(id));
    }
  }
  return [...ids];
};

export default { mergeTechnicianCandidateIds };
