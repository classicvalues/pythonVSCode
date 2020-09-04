// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { nbformat } from '@jupyterlab/coreutils/lib/nbformat';
import { sha256 } from 'hash.js';
import { Event, EventEmitter, Memento, Uri } from 'vscode';
import { ICryptoUtils } from '../../common/types';
import { isUntitledFile } from '../../common/utils/misc';
import { NotebookModelChange } from '../interactive-common/interactiveWindowTypes';
import {
    getInterpreterFromKernelConnectionMetadata,
    kernelConnectionMetadataHasKernelModel
} from '../jupyter/kernels/helpers';
import { KernelConnectionMetadata } from '../jupyter/kernels/types';
import { ICell, INotebookMetadataLive, INotebookModel } from '../types';

export const ActiveKernelIdList = `Active_Kernel_Id_List`;
// This is the number of kernel ids that will be remembered between opening and closing VS code
export const MaximumKernelIdListSize = 40;
type KernelIdListEntry = {
    fileHash: string;
    kernelId: string | undefined;
};

// tslint:disable-next-line: cyclomatic-complexity
export function updateNotebookMetadata(
    metadata?: nbformat.INotebookMetadata,
    kernelConnection?: KernelConnectionMetadata
) {
    let changed = false;
    let kernelId: string | undefined;
    if (!metadata) {
        return { changed, kernelId };
    }

    // Get our kernel_info and language_info from the current notebook
    const interpreter = getInterpreterFromKernelConnectionMetadata(kernelConnection);
    if (
        interpreter &&
        interpreter.version &&
        metadata &&
        metadata.language_info &&
        metadata.language_info.version !== interpreter.version.raw
    ) {
        metadata.language_info.version = interpreter.version.raw;
        changed = true;
    } else if (!interpreter && metadata?.language_info) {
        // It's possible, such as with raw kernel and a default kernelspec to not have interpreter info
        // for this case clear out old invalid language_info entries as they are related to the previous execution
        metadata.language_info = undefined;
        changed = true;
    }

    const kernelSpecOrModel =
        kernelConnection && kernelConnectionMetadataHasKernelModel(kernelConnection)
            ? kernelConnection.kernelModel
            : kernelConnection?.kernelSpec;
    if (kernelSpecOrModel && !metadata.kernelspec) {
        // Add a new spec in this case
        metadata.kernelspec = {
            name: kernelSpecOrModel.name || kernelSpecOrModel.display_name || '',
            display_name: kernelSpecOrModel.display_name || kernelSpecOrModel.name || ''
        };
        kernelId = kernelSpecOrModel.id;
        changed = true;
    } else if (kernelSpecOrModel && metadata.kernelspec) {
        // Spec exists, just update name and display_name
        const name = kernelSpecOrModel.name || kernelSpecOrModel.display_name || '';
        const displayName = kernelSpecOrModel.display_name || kernelSpecOrModel.name || '';
        if (
            metadata.kernelspec.name !== name ||
            metadata.kernelspec.display_name !== displayName ||
            kernelId !== kernelSpecOrModel.id
        ) {
            changed = true;
            metadata.kernelspec.name = name;
            metadata.kernelspec.display_name = displayName;
            kernelId = kernelSpecOrModel.id;
        }
    } else if (kernelConnection?.kind === 'startUsingPythonInterpreter') {
        // Store interpreter name, we expect the kernel finder will find the corresponding interpreter based on this name.
        const name = kernelConnection.interpreter.displayName || kernelConnection.interpreter.path;
        if (metadata.kernelspec?.name !== name || metadata.kernelspec?.display_name !== name) {
            changed = true;
            metadata.kernelspec = {
                name,
                display_name: name,
                metadata: {
                    interpreter: {
                        hash: sha256().update(kernelConnection.interpreter.path).digest('hex')
                    }
                }
            };
        }
    }
    return { changed, kernelId };
}

export function getDefaultNotebookContent(pythonNumber: number = 3): Partial<nbformat.INotebookContent> {
    // Use this to build our metadata object
    // Use these as the defaults unless we have been given some in the options.
    const metadata: nbformat.INotebookMetadata = {
        language_info: {
            codemirror_mode: {
                name: 'ipython',
                version: pythonNumber
            },
            file_extension: '.py',
            mimetype: 'text/x-python',
            name: 'python',
            nbconvert_exporter: 'python',
            pygments_lexer: `ipython${pythonNumber}`,
            version: pythonNumber
        },
        orig_nbformat: 2
    };

    // Default notebook data.
    return {
        metadata: metadata,
        nbformat: 4,
        nbformat_minor: 2
    };
}
export abstract class BaseNotebookModel implements INotebookModel {
    public get onDidDispose() {
        return this._disposed.event;
    }
    public get isDisposed() {
        return this._isDisposed === true;
    }
    public get isDirty(): boolean {
        return false;
    }
    public get changed(): Event<NotebookModelChange> {
        return this._changedEmitter.event;
    }
    public get file(): Uri {
        return this._file;
    }

    public get isUntitled(): boolean {
        return isUntitledFile(this.file);
    }
    public get onDidEdit(): Event<NotebookModelChange> {
        return this._editEventEmitter.event;
    }
    public get metadata(): INotebookMetadataLive | undefined {
        return this.kernelId && this.notebookJson.metadata
            ? {
                  ...this.notebookJson.metadata,
                  id: this.kernelId
              }
            : // Fix nyc compiler problem
              // tslint:disable-next-line: no-any
              (this.notebookJson.metadata as any);
    }
    public get isTrusted() {
        return this._isTrusted;
    }

    protected _disposed = new EventEmitter<void>();
    protected _isDisposed?: boolean;
    protected _changedEmitter = new EventEmitter<NotebookModelChange>();
    protected _editEventEmitter = new EventEmitter<NotebookModelChange>();
    private kernelId: string | undefined;
    constructor(
        protected _isTrusted: boolean,
        protected _file: Uri,
        protected globalMemento: Memento,
        private crypto: ICryptoUtils,
        protected notebookJson: Partial<nbformat.INotebookContent> = {},
        public readonly indentAmount: string = ' ',
        private readonly pythonNumber: number = 3
    ) {
        this.ensureNotebookJson();
        this.kernelId = this.getStoredKernelId();
    }
    public get cells(): readonly Readonly<ICell>[] {
        // Possible the document has been closed/disposed
        if (this.isDisposed) {
            return [];
        }
        return this.getICells();
    }
    public dispose() {
        this._isDisposed = true;
        this._disposed.fire();
    }
    public getContent(): string {
        const json = this.generateNotebookJson();
        return JSON.stringify(json, null, this.indentAmount);
    }
    public getRawContent(): nbformat.INotebookContent {
        return this.generateNotebookJson();
    }
    public trust() {
        this._isTrusted = true;
    }
    protected generateNotebookJson(): nbformat.INotebookContent {
        // Make sure we have some
        this.ensureNotebookJson();

        // Reuse our original json except for the cells.
        const json = { ...this.notebookJson };
        json.cells = this.getJupyterCells(); //     this.cells.map((c) => pruneCell(c.data));
        // tslint:disable-next-line: no-any
        return json as any;
    }
    protected getJupyterCells(): nbformat.ICell[] | undefined {
        return [];
    }
    protected getICells(): ICell[] {
        return [];
    }
    private ensureNotebookJson() {
        if (!this.notebookJson || !this.notebookJson.metadata) {
            this.notebookJson = getDefaultNotebookContent(this.pythonNumber);
        }
    }

    private getStoredKernelId(): string | undefined {
        // Stored as a list so we don't take up too much space
        const list: KernelIdListEntry[] = this.globalMemento.get<KernelIdListEntry[]>(ActiveKernelIdList, []);
        if (list) {
            // Not using a map as we're only going to store the last 40 items.
            const fileHash = this.crypto.createHash(this._file.toString(), 'string');
            const entry = list.find((l) => l.fileHash === fileHash);
            return entry?.kernelId;
        }
    }
}
