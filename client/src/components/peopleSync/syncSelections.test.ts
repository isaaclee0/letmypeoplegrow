import { describe, expect, it } from 'vitest';
import { buildSyncSelections } from './syncSelections';

describe('buildSyncSelections', () => {
  it('serializes only reviewer decisions into a deterministic apply payload', () => {
    expect(buildSyncSelections({
      ambiguousChoices: { ext2: null, ext1: 7 },
      skippedExternalIds: new Set(['ext3', 'ext0']),
      visitorChoices: { ext5: null, ext4: 'promote' },
      acceptedArchiveIds: new Set([10, 2]),
      acceptedFamilyRenameIds: new Set(['renameFamily:20', 'renameFamily:3']),
    })).toEqual({
      ambiguous: { ext1: 7 },
      skipExternalPersonIds: ['ext0', 'ext3'],
      visitorChoices: { ext4: 'promote' },
      acceptArchiveIndividualIds: [2, 10],
      acceptFamilyRenameIds: ['renameFamily:20', 'renameFamily:3'],
    });
  });
});
