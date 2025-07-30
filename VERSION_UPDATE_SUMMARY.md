# Version Update Script - Comprehensive Coverage

## Overview
The `update-version.sh` script has been enhanced to update version numbers across the entire codebase, ensuring consistency and preventing missed version references.

## Files Updated by the Script

### Core Application Files
1. **`client/package.json`** - Frontend application version
2. **`server/package.json`** - Backend application version
3. **`client/src/utils/version.ts`** - Version utility fallback value

### Build and Deployment Files
4. **`build-and-push.sh`** - Default version for Docker builds
5. **`docker-compose.prod.yml`** - Default Docker image versions
6. **`.env.example`** - Example environment variable for image tag

### Documentation Files
7. **`README.md`** - Current version reference in documentation
8. **`DEPLOYMENT.md`** - Deployment guide version references
9. **`DOCKER_HUB_DEPLOYMENT.md`** - Docker Hub deployment guide versions
10. **`PORTAINER_DEPLOYMENT.md`** - Portainer deployment guide versions
11. **`MIGRATION_FIX_SUMMARY.md`** - Migration documentation versions

### Script Files
12. **`server/scripts/*.js`** - Any version references in server scripts

## Version Patterns Updated

### Package.json Versions
- Pattern: `"version": "0.8.4"`
- Updated to: `"version": "NEW_VERSION"`

### Docker Image Versions
- Pattern: `:v0.8.4`
- Updated to: `:vNEW_VERSION`

### Build Script Default
- Pattern: `VERSION=${1:-v0.8.4}`
- Updated to: `VERSION=${1:-vNEW_VERSION}`

### Environment Variables
- Pattern: `IMAGE_TAG=v0.8.4`
- Updated to: `IMAGE_TAG=vNEW_VERSION`

### Documentation References
- Pattern: `### v0.8.4 (Current)`
- Updated to: `### vNEW_VERSION (Current)`

### Version Utility Fallback
- Pattern: `return '0.8.4';`
- Updated to: `return 'NEW_VERSION';`

## Usage

```bash
# Update to a new version
./update-version.sh 0.8.5

# The script will:
# 1. Update all version references across the codebase
# 2. Validate that key files were updated correctly
# 3. Provide a summary of what was updated
# 4. Give next steps for committing and building
```

## Validation

The script includes validation to ensure updates were successful:

- ✅ Checks package.json files for correct version
- ✅ Verifies build script default version
- ✅ Confirms Docker compose file updates
- ✅ Validates version utility fallback
- ✅ Reports any files that weren't updated

## Benefits

1. **Comprehensive Coverage**: Updates versions in all relevant files
2. **Consistency**: Ensures all version references are synchronized
3. **Validation**: Confirms updates were successful
4. **Documentation**: Updates all documentation to reflect current version
5. **Automation**: Reduces manual errors in version management

## Previous Issues Fixed

### Missing Updates
The original script only updated:
- `client/package.json`
- `server/package.json`
- `build-and-push.sh`

### New Coverage
The enhanced script now also updates:
- Docker compose files
- Environment examples
- All documentation files
- Version utility fallbacks
- Server scripts
- And validates all updates

## Best Practices

1. **Always run validation**: The script validates updates automatically
2. **Review changes**: Check the git diff before committing
3. **Test builds**: Ensure the new version builds correctly
4. **Update changelog**: Consider adding a changelog entry
5. **Tag releases**: Create git tags for releases

## Example Output

```
Updating version to 0.8.5...
Updating client/package.json...
Updating server/package.json...
Updating build-and-push.sh...
Updating docker-compose.prod.yml...
Updating client/src/utils/version.ts...
Updating .env.example...
Updating documentation files...
Updating server scripts...

🔍 Validating version updates...
Checking key files for version 0.8.5:
  ✅ client/package.json
  ✅ server/package.json
  ✅ build-and-push.sh
  ✅ docker-compose.prod.yml
  ✅ client/src/utils/version.ts

✅ Version updated to 0.8.5 in all files!

Files updated:
  - client/package.json
  - server/package.json
  - build-and-push.sh
  - docker-compose.prod.yml
  - client/src/utils/version.ts
  - .env.example
  - README.md
  - DEPLOYMENT.md
  - DOCKER_HUB_DEPLOYMENT.md
  - PORTAINER_DEPLOYMENT.md
  - MIGRATION_FIX_SUMMARY.md
  - server/scripts/*.js

Next steps:
  1. Commit the changes: git add . && git commit -m "Update version to 0.8.5"
  2. Build and push: ./build-and-push.sh v0.8.5
```

## Notes

- The script uses macOS-compatible `sed` syntax (`sed -i ''`)
- All regex patterns are designed to match semantic versioning format
- The script is idempotent - running it multiple times won't cause issues
- Validation ensures no version references are missed
- Documentation updates maintain consistency across all guides 