# Implementation Plan - Project & Environment Mapping for Console URLs

This plan outlines the changes needed to dynamically resolve the project UUID and environment name from the Coolify API, allowing the "Open in Coolify Console" button to navigate directly to the specific container application page (e.g., `http://<server>/project/<projectUuid>/environment/<environmentName>/application/<applicationUuid>`) instead of falling back to the generic `http://<server>/project` page.

## User Review Required

> [!IMPORTANT]
> To avoid overloading the Coolify server with N+1 requests on every refresh (every 5 seconds), we will fetch projects and environments only on:
> - The first load of the webview (when the cache map is empty).
> - A manual refresh request (when the user clicks the refresh button).
> - When an application has an `environment_id` not currently found in our cache map.

## Proposed Changes

### Core API Client

We will extend `CoolifyService` with methods to list projects and get the environments list of a project.

#### [MODIFY] [CoolifyService.ts](file:///c:/Users/Lenovo/Documents/coolify_extesion_manager/coolify-vscode-extension/src/services/CoolifyService.ts)
- Add `getProjects` method to fetch `/api/v1/projects`.
- Add `getProjectEnvironments` method to fetch `/api/v1/projects/${projectUuid}/environments`.

---

### Webview Backend Manager

We will update `CoolifyWebViewProvider` to manage the cache map of `environment_id` -> `{ projectUuid, environmentName }` and resolve the exact console URL.

#### [MODIFY] [CoolifyWebViewProvider.ts](file:///c:/Users/Lenovo/Documents/coolify_extesion_manager/coolify-vscode-extension/src/providers/CoolifyWebViewProvider.ts)
- Add a private `envMap` cache property: `Map<number | string, { projectUuid: string; environmentName: string }>` to store resolved environment paths.
- Modify `refreshData()` to:
  - Check if any applications have an `environment_id` that is not in `envMap`.
  - If the cache is empty or has missing keys (or if it is a manual force-refresh), fetch the projects and environments list to rebuild the map.
  - In `emitState()`, check `a.environment_id` against the cache to obtain `projectUuid` and `environmentName`. If found, generate the precise application console URL.

---

## Verification Plan

### Automated Tests
- Run `pnpm run compile` to verify that there are no TypeScript compile/build errors.

### Manual Verification
- Launch the VS Code Extension in the extension development host.
- Click the "Open in Coolify Console" button for a container without FQDN configured.
- Verify that it opens the exact console URL: `http://<server>/project/<project_uuid>/environment/<environment_name>/application/<application_uuid>`.
