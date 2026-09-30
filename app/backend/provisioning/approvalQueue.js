'use strict';

const crypto = require('crypto');

const PENDING = 'pending';
const APPROVED = 'approved';
const REJECTED = 'rejected';
const EXECUTED = 'executed';
const FAILED = 'failed';

function createApprovalQueue({ now = () => new Date() } = {}) {
  const items = new Map();

  function enqueue(proposal) {
    const id = proposal.id || `prov_${crypto.randomBytes(8).toString('hex')}`;
    const queued = {
      ...proposal,
      id,
      status: PENDING,
      createdAt: proposal.createdAt || now().toISOString(),
      approvedAt: null,
      rejectedAt: null,
      executedAt: null,
      failedAt: null,
      executionResult: null,
      error: null,
    };
    items.set(id, queued);
    return clone(queued);
  }

  function list({ accountId, status } = {}) {
    return Array.from(items.values())
      .filter((item) => !accountId || item.accountId === accountId)
      .filter((item) => !status || item.status === status)
      .map(clone);
  }

  function get(id) {
    const item = items.get(id);
    return item ? clone(item) : null;
  }

  function approve(id, { approvedBy, confirmText } = {}) {
    const item = requireItem(items, id);
    if (item.status !== PENDING) {
      throw new Error(`Action ${id} is ${item.status}, not pending`);
    }
    if (item.requiresConfirmText && item.requiresConfirmText !== confirmText) {
      throw new Error(`Action ${id} requires confirm text: ${item.requiresConfirmText}`);
    }

    item.status = APPROVED;
    item.approvedBy = approvedBy || null;
    item.approvedAt = now().toISOString();
    return clone(item);
  }

  function reject(id, { rejectedBy, reason } = {}) {
    const item = requireItem(items, id);
    if (item.status !== PENDING) {
      throw new Error(`Action ${id} is ${item.status}, not pending`);
    }

    item.status = REJECTED;
    item.rejectedBy = rejectedBy || null;
    item.rejectedReason = reason || null;
    item.rejectedAt = now().toISOString();
    return clone(item);
  }

  function markExecuted(id, result) {
    const item = requireItem(items, id);
    if (item.status !== APPROVED) {
      throw new Error(`Action ${id} must be approved before execution`);
    }

    item.status = EXECUTED;
    item.executedAt = now().toISOString();
    item.executionResult = clone(result);
    return clone(item);
  }

  function markFailed(id, error, result = null) {
    const item = requireItem(items, id);
    if (item.status !== APPROVED) {
      throw new Error(`Action ${id} must be approved before failure can be recorded`);
    }
    item.status = FAILED;
    item.failedAt = now().toISOString();
    item.executionResult = result == null ? null : clone(result);
    item.error = String(error && error.message ? error.message : error || 'Execution failed');
    return clone(item);
  }

  return { enqueue, list, get, approve, reject, markExecuted, markFailed };
}

function requireItem(items, id) {
  const item = items.get(id);
  if (!item) throw new Error(`Unknown approval action: ${id}`);
  return item;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createApprovalQueue,
  statuses: { PENDING, APPROVED, REJECTED, EXECUTED, FAILED },
};
