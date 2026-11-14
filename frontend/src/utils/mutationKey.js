export const createMutationKey = () =>
  `user-${Date.now()}-${Math.random().toString(36).slice(2, 18)}`;

export function getMutationAttempt(ref, payload) {
  const signature = JSON.stringify(payload);
  if (!ref.current.key || ref.current.signature !== signature) {
    ref.current = { key: createMutationKey(), signature };
  }
  return ref.current.key;
}
