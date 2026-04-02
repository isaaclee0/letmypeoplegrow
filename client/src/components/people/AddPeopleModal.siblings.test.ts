import { describe, it, expect } from 'vitest';

interface Card { id: string; firstName: string; siblingGroupId: string | null }

function groupCards(cards: Card[]) {
  const siblingGroups = new Map<string, Card[]>();
  const soloCards: Card[] = [];
  for (const card of cards) {
    if (card.siblingGroupId) {
      const g = siblingGroups.get(card.siblingGroupId) ?? [];
      g.push(card);
      siblingGroups.set(card.siblingGroupId, g);
    } else {
      soloCards.push(card);
    }
  }
  return { siblingGroups, soloCards };
}

describe('individual card sibling grouping', () => {
  it('puts solo cards in soloCards', () => {
    const cards: Card[] = [
      { id: '1', firstName: 'Alice', siblingGroupId: null },
      { id: '2', firstName: 'Bob', siblingGroupId: null },
    ];
    const { soloCards, siblingGroups } = groupCards(cards);
    expect(soloCards).toHaveLength(2);
    expect(siblingGroups.size).toBe(0);
  });

  it('groups linked cards by siblingGroupId', () => {
    const cards: Card[] = [
      { id: '1', firstName: 'Alice', siblingGroupId: 'g1' },
      { id: '2', firstName: 'Bob', siblingGroupId: 'g1' },
      { id: '3', firstName: 'Carol', siblingGroupId: null },
    ];
    const { soloCards, siblingGroups } = groupCards(cards);
    expect(soloCards).toHaveLength(1);
    expect(soloCards[0].firstName).toBe('Carol');
    expect(siblingGroups.get('g1')).toHaveLength(2);
  });

  it('handles multiple sibling groups', () => {
    const cards: Card[] = [
      { id: '1', firstName: 'A', siblingGroupId: 'g1' },
      { id: '2', firstName: 'B', siblingGroupId: 'g1' },
      { id: '3', firstName: 'C', siblingGroupId: 'g2' },
      { id: '4', firstName: 'D', siblingGroupId: 'g2' },
    ];
    const { soloCards, siblingGroups } = groupCards(cards);
    expect(soloCards).toHaveLength(0);
    expect(siblingGroups.size).toBe(2);
  });
});
