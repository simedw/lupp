import test from "node:test";
import assert from "node:assert/strict";
import { createObservationList } from "../desktop/observation-list.js";

// Minimal DOM list: count insertions/removals as well as checking final order.
type Observation = { id: string; status: string; finding?: { summary: string } };
type Card = { observation: Observation | null; audio: { currentTime: number }; status?: string; finding?: { summary: string }; remove(): void };
function ledger() {
  const list = {
    children: [] as Card[], scrollTop: 180, mutations: 0,
    get firstChild() { return this.children[0]; },
    append(card: Card) { this.insertBefore(card, null); },
    insertBefore(card: Card, before: Card | null) {
      this.mutations++;
      card.remove();
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index, 0, card);
    },
    replaceChildren() { this.children = []; this.mutations++; }
  };
  const makeCard = (observation: Observation | null): Card => ({
    observation,
    audio: { currentTime: 14 },
    remove() {
      const index = list.children.indexOf(this);
      if (index !== -1) { list.children.splice(index, 1); list.mutations++; }
    }
  });
  const render = createObservationList<Observation, Card>(list, {
    createCard: makeCard,
    createEmpty: () => makeCard(null),
    updateCard(card, observation) { card.status = observation.status; card.finding = observation.finding; }
  });
  return { list, render };
}

test("a new investigation keeps an earlier answer, card, playback and scroll in place", () => {
  const { list, render } = ledger();
  const first = { id: "n1", status: "ready", finding: { summary: "The answer" } };
  render([first]);
  const firstCard = list.firstChild;
  const second = { id: "n2", status: "queued" };
  render([first, second]);
  assert.equal(list.firstChild, firstCard);
  assert.equal(firstCard.finding?.summary, "The answer");
  assert.equal(firstCard.status, "ready");
  assert.equal(firstCard.audio.currentTime, 14);
  assert.equal(list.scrollTop, 180);
  const mutations = list.mutations;
  second.status = "investigating";
  render([first, second]);
  assert.equal(list.mutations, mutations, "progress must not remount or reorder cards");
  assert.equal(list.children[1].status, "investigating");
  assert.equal(firstCard.status, "ready");
});

test("deletion, empty state and reopening a review do not retain stale cards", () => {
  const { list, render } = ledger();
  render([]);
  const first = { id: "n1", status: "ready" };
  const second = { id: "n2", status: "queued" };
  render([first, second]);
  const secondCard = list.children[1];
  render([second]);
  assert.equal(list.firstChild, secondCard);
  render([]);
  assert.equal(list.children.length, 1);
  assert.equal(list.firstChild.observation, null);
  render([{ id: "n2", status: "saved" }]);
  assert.notEqual(list.firstChild, secondCard);
  assert.equal(list.firstChild.status, "saved");
});
