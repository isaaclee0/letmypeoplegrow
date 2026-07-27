import { describe, expect, it } from 'vitest';
import { familyAuthorityPermissions, personAuthorityPermissions } from './PeoplePage';

describe('PeoplePage authority permissions', () => {
  it('locks only provider-managed person fields and lifecycle actions while preserving badge and gathering edits', () => {
    const permissions = personAuthorityPermissions({ planning_center: 'pco-7' }, 'planning_center');

    expect(permissions).toEqual({
      locked: true,
      canOpenEditor: true,
      canEditManagedFields: false,
      canEditBadge: true,
      canEditGatherings: true,
      canArchive: false,
      canRestore: false,
      canDelete: false,
      canMerge: false,
    });
  });

  it('honors inherited family managedBy without a direct family link and still permits notes', () => {
    expect(familyAuthorityPermissions({ externalLinks: {}, managedBy: 'elvanto' }, 'elvanto')).toEqual({
      locked: true,
      canManageFamily: false,
      canEditNotes: true,
    });
  });
});
