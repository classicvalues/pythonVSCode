// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import { Disposable, Uri } from 'vscode';
import { IPathUtils, Resource } from '../../../common/types';
import { PythonEnvironment } from '../../../pythonEnvironments/info';
import { IInterpreterService } from '../../contracts';
import { IInterpreterQuickPickItem, IInterpreterSelector } from '../types';

@injectable()
export class InterpreterSelector implements IInterpreterSelector {
    private disposables: Disposable[] = [];

    constructor(
        @inject(IInterpreterService) private readonly interpreterManager: IInterpreterService,
        // @inject(IInterpreterComparer) private readonly interpreterComparer: IInterpreterComparer,
        // @inject(IExperimentsManager) private readonly experimentsManager: IExperimentsManager,
        // @inject(IInterpreterSecurityService) private readonly interpreterSecurityService: IInterpreterSecurityService,
        @inject(IPathUtils) private readonly pathUtils: IPathUtils
    ) {}
    public dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    public async getSuggestions(resource: Resource) {
        const interpreters = await this.interpreterManager.getInterpreters(resource);
        // interpreters.sort(this.interpreterComparer.compare.bind(this.interpreterComparer));
        return Promise.all(interpreters.map((item) => this.suggestionToQuickPickItem(item, resource)));
    }

    protected async suggestionToQuickPickItem(
        suggestion: PythonEnvironment,
        workspaceUri?: Uri
    ): Promise<IInterpreterQuickPickItem> {
        const detail = this.pathUtils.getDisplayName(suggestion.path, workspaceUri ? workspaceUri.fsPath : undefined);
        // const cachedPrefix = suggestion.cachedEntry ? '(cached) ' : '';
        return {
            // tslint:disable-next-line:no-non-null-assertion
            label: suggestion.displayName!,
            detail,
            path: suggestion.path,
            interpreter: suggestion
        };
    }
}
