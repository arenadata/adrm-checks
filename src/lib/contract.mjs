// Shared pieces of the ADRM report contracts (line.json for mode=inspect, dependencies.json for mode=dependencies):
// argument parsing, identity regexes, the inputs every run dispatched on a branch receives from the wrapper, and the
// gate that turns a stale or broken dispatch into a diagnostic instead of a report built on the wrong commit.

export const SHA = /^[0-9a-f]{40}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<command> --key value --flag`: a value starting with `--` is taken as the next key, so file paths go through files. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true; else { opts[key] = next; i++; }
  }
  return { command, opts };
}

/**
 * Inputs of a run dispatched by ADRM on a branch, read from the workflow environment: REQUEST_ID, GENERATION,
 * GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID, GITHUB_REF_NAME, GITHUB_SHA, EXPECTED_HEAD_SHA, GITHUB_WORKFLOW_REF,
 * GITHUB_WORKFLOW_SHA, EXPECTED_CHECKER_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT. Returns the raw inputs, the list of
 * invalid ones (in the order ADRM shows them), the branch state and the identity blocks every report carries.
 */
export function readBranchDispatch(env) {
  const inputs = {
    requestId: env.REQUEST_ID ?? '', generation: Number(env.GENERATION), repository: env.GITHUB_REPOSITORY ?? '', repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    branch: env.GITHUB_REF_NAME ?? '', headSha: env.GITHUB_SHA ?? '', expectedHeadSha: env.EXPECTED_HEAD_SHA ?? '',
    checker: { workflowRef: env.GITHUB_WORKFLOW_REF ?? '', workflowSha: env.GITHUB_WORKFLOW_SHA ?? '', expectedSha: env.EXPECTED_CHECKER_SHA ?? '', runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) },
  };
  const invalid = [];
  if (!UUID.test(inputs.requestId)) invalid.push('request_id');
  if (!Number.isSafeInteger(inputs.generation) || inputs.generation < 0) invalid.push('generation');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(inputs.repository) || !Number.isSafeInteger(inputs.repositoryId) || inputs.repositoryId <= 0) invalid.push('repository identity');
  if (!inputs.branch || inputs.branch.length > 256 || inputs.branch.startsWith('refs/')) invalid.push('branch');
  if (!SHA.test(inputs.headSha) || !SHA.test(inputs.expectedHeadSha)) invalid.push('head sha');
  if (!SHA.test(inputs.checker.workflowSha) || !SHA.test(inputs.checker.expectedSha)) invalid.push('checker sha');
  if (!inputs.checker.workflowRef.startsWith(`${inputs.repository}/.github/workflows/`) || !/@refs\/(heads|tags)\/[^\s]+$/.test(inputs.checker.workflowRef) || inputs.checker.workflowRef.length > 1024) invalid.push('workflow_ref');
  if (!Number.isSafeInteger(inputs.checker.runId) || inputs.checker.runId <= 0 || !Number.isSafeInteger(inputs.checker.runAttempt) || inputs.checker.runAttempt <= 0) invalid.push('run identity');

  const headSha = SHA.test(inputs.headSha) ? inputs.headSha : null;
  const branchState = !headSha ? 'missing' : headSha === inputs.expectedHeadSha ? 'resolved' : 'changed';
  return {
    inputs, invalid, headSha, branchState,
    repository: { provider: 'github', id: inputs.repositoryId, fullName: inputs.repository },
    checker: { workflowRef: inputs.checker.workflowRef, workflowSha: inputs.checker.workflowSha, runId: inputs.checker.runId, runAttempt: inputs.checker.runAttempt, runUrl: `https://github.com/${inputs.repository}/actions/runs/${inputs.checker.runId}` },
  };
}

/**
 * The gate every branch-mode report passes before reading or building anything. Returns null when the run may go on,
 * otherwise the diagnostic to report instead: invalid inputs, a branch head that moved since ADRM looked, a wrapper
 * revision other than the one ADRM expected, or a failed preparatory step. `texts.skipped` and `texts.setupSkipped`
 * say what was not done ("версия не читалась", "build-файлы не читались").
 */
export function dispatchGate(d, env, texts) {
  if (d.invalid.length) return { code: 'INPUT_INVALID', message: `Некорректные входные данные workflow: ${d.invalid.join(', ')}.`, retryable: false };
  if (d.branchState === 'changed') return { code: 'HEAD_CHANGED', message: `Голова ветки ${d.inputs.branch} (${d.headSha.slice(0, 7)}) отличается от ожидаемой ADRM; ${texts.skipped}.`, retryable: true };
  if (d.inputs.checker.workflowSha !== d.inputs.checker.expectedSha) return { code: 'CHECKER_CHANGED', message: `Версия проверяющего workflow отличается от ожидаемой ADRM; ${texts.skipped}.`, retryable: true };
  if (env.CHECKER_SETUP_STATUS && env.CHECKER_SETUP_STATUS !== 'success') return { code: 'CHECKER_SETUP_ERROR', message: `Подготовительный шаг workflow завершился с ошибкой; ${texts.setupSkipped}.`, retryable: true };
  return null;
}
