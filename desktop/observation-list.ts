// Reconcile by observation identity so progress never remounts another note,
// restarts its audio, or moves a newly captured note into its place.
type Removable = { remove(): void };
type List<N> = {
  scrollTop: number;
  firstChild: unknown;
  children: ArrayLike<unknown>;
  append(node: N): void;
  replaceChildren(): void;
  insertBefore(node: N, before: N | null): unknown;
};

export function createObservationList<O, N extends Removable>(list: List<N>, { createCard, updateCard, createEmpty }: {
  createCard(observation: O): N;
  updateCard(card: N, observation: O): void;
  createEmpty(): N;
}) {
  const cards = new Map<O, N>();
  return (observations: O[]) => {
    const scrollTop = list.scrollTop;
    const current = new Set(observations);
    for (const [observation, card] of cards) {
      if (!current.has(observation)) {
        card.remove();
        cards.delete(observation);
      }
    }
    if (!observations.length) {
      if (!list.firstChild) list.append(createEmpty());
      return;
    }
    if (!cards.size) list.replaceChildren();
    observations.forEach((observation, index) => {
      let card = cards.get(observation);
      if (!card) {
        card = createCard(observation);
        cards.set(observation, card);
      }
      updateCard(card, observation);
      if (list.children[index] !== card) list.insertBefore(card, (list.children[index] as N | undefined) || null);
    });
    list.scrollTop = scrollTop;
  };
}
