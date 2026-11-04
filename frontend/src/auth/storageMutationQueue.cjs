function createStorageMutationQueue() {
  let pending = Promise.resolve();
  return (operation) => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => {});
    return result;
  };
}

module.exports = { createStorageMutationQueue };
