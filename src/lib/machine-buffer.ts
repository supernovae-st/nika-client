/**
 * `machineBufferBytes`: the most the SDK holds of one machine frame (a native
 * stdout line, a resident SSE frame) or one machine document (a JSON body, a
 * captured report) before it refuses.
 *
 * The default is the resident's own record bound. `nika serve` keeps its whole
 * durable job store in one document of at most 16 MiB (`MAX_JOB_SNAPSHOT_BYTES`
 * in engine 0.123.1): a result that would make the store larger is refused,
 * never truncated, and the job does not settle with it. A job's terminal SSE
 * frame and its `GET /v1/jobs/{id}` record carry a part of that store (outputs,
 * receipt, settlement) plus less framing than the store spends on that job, so
 * every result a resident can settle fits one 16 MiB frame and one 16 MiB body.
 * Measured on 0.123.1: a 200,049-byte outputs map rode a 200,756-byte frame and
 * a 200,815-byte record.
 *
 * A local engine sets no such bound: its `run_settled` line carries the outputs
 * whole, whatever their size, and a task's output rides its `task_completed`
 * line. A local result above 16 MiB needs a larger value, and the refusal names
 * the size to set.
 */
export const DEFAULT_MACHINE_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * How many bytes of an oversized frame the SDK reads, counting and discarding
 * them, to say how large it is. Past this the refusal reports a lower bound.
 * Nothing is buffered while counting.
 */
export const OVERFLOW_MEASURE_LIMIT_BYTES = 1024 * 1024 * 1024;

/** A size the SDK measured: exact, or a lower bound when it could not read to the end. */
export interface MeasuredSize {
  readonly bytes: number;
  readonly exact: boolean;
}

/**
 * The refusal text for a frame or document past `machineBufferBytes`: the
 * bound, the option that sets it, and the size that would have been needed.
 * `fitsDefault` marks a resident's frame or record, which the default holds:
 * under a smaller explicit bound, and for a size the default covers, the text
 * adds that leaving the option unset works too.
 */
export function machineBufferExceeded(
  subject: string,
  limit: number,
  size: MeasuredSize,
  options: { fitsDefault?: boolean; advice?: string } = {},
): string {
  const needed = size.exact
    ? `it is ${size.bytes} bytes. Set machineBufferBytes to at least ${size.bytes}`
    : `it is at least ${size.bytes} bytes. Set machineBufferBytes above ${size.bytes}`;
  const fallback = options.fitsDefault === true
    && limit < DEFAULT_MACHINE_BUFFER_BYTES
    && size.bytes <= DEFAULT_MACHINE_BUFFER_BYTES
    ? ', or leave it unset: its 16 MiB default holds any result nika serve settles'
    : '';
  const advice = options.advice ? `. ${options.advice}` : '';
  return `${subject} exceeded ${limit} bytes (machineBufferBytes): ${needed}${fallback}${advice}`;
}
