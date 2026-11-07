// One wait for a side call. The caller owns the timer. A late answer is dropped here,
// even when the provider cannot abort the request.

/** Race `promise` against `timeout` ms. The promise's own rejection is returned, not thrown. */
export function ownedCall(promise, timeout) {
    let timer;
    const settled = Promise.resolve(promise).then(raw => ({ raw }), error => ({ error }));
    return Promise.race([
        settled,
        new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), timeout); }),
    ]).finally(() => clearTimeout(timer));
}
