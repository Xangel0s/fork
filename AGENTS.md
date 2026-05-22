# Agent Instructions for coolify-vscode-extension

Welcome! This workspace contains a VS Code extension to track and deploy Coolify applications.

## Project Structure
- `src/extension.ts`: Main activation script, commands registration.
- `src/providers/CoolifyWebViewProvider.ts`: Backend webview logic.
- `src/templates/webview.html`: Webview frontend structure, styles, and inline script.
- `src/managers/ConfigurationManager.ts`: Configuration settings loader.
- `src/services/CoolifyService.ts`: Core client API communication.
- `scripts/copy-templates.js`: Automation to copy html files from `src/templates` to `dist/templates`.

## Coding Principles & Rules
1. **SOLID Principles**: Maintain clean separations between services, providers, and managers.
2. **DRY & KISS**: Avoid duplicate layout styles. Write clean, self-documenting code.
3. **Change Management**: Show a diff/preview of changes to the user and confirm before modifying files.
4. **Git Commits**: Commit incrementally after each completed task using conventional commits format.
5. **Testing**: Keep test coverage high and run tests before finalizing.

## Webview Redesign Philosophy
- **Rich Aesthetics**: High-quality dark styles using VS Code color tokens mixed with Coolify brand HSL colors.
- **Modules/Cards**: Divide applications and history into visually distinct blocks.
- **Intuitive Toggles**: Use tabbed headers or pill buttons for filtering statuses instead of plain radio buttons.
- **Feedback & States**: Pulse animations, smooth transitions, and spinner icons for asynchronous updates.
