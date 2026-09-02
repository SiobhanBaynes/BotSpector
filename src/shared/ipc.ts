// IPC channel names shared between preload and main.

export const IPC = {
  // Settings
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  repositoryProfileSave: 'settings:repositoryProfileSave',
  repositoryProfileSelect: 'settings:repositoryProfileSelect',
  repositoryProfileDelete: 'settings:repositoryProfileDelete',
  setAdoPat: 'settings:setAdoPat',
  detectIdentity: 'settings:detectIdentity',

  // Copilot auth
  copilotStartLogin: 'copilot:startLogin',
  copilotCancelLogin: 'copilot:cancelLogin',
  copilotSignOut: 'copilot:signOut',
  copilotListModels: 'copilot:listModels',
  // main -> renderer events
  copilotDeviceCode: 'copilot:deviceCode',
  copilotLoginStatus: 'copilot:loginStatus',

  // Skills
  skillList: 'skill:list',
  skillGetInstructions: 'skill:getInstructions',
  skillSaveInstructions: 'skill:saveInstructions',
  skillImport: 'skill:import',
  skillImportGit: 'skill:importGit',
  skillOpenFolder: 'skill:openFolder',
  skillRemove: 'skill:remove',

  // Pull requests
  prList: 'pr:list',
  prListCached: 'pr:listCached',
  prGet: 'pr:get',
  prRefresh: 'pr:refresh',
  prGetReview: 'pr:getReview',
  prGetReviewHistory: 'pr:getReviewHistory',
  prGetPostedComments: 'pr:getPostedComments',
  prSetReviewStatus: 'pr:setReviewStatus',
  prGetAdoDetails: 'pr:getAdoDetails',
  prSetVote: 'pr:setVote',
  prSetAdoStatus: 'pr:setAdoStatus',
  prSetDraft: 'pr:setDraft',
  prReview: 'pr:review',
  prReviewPanel: 'pr:reviewPanel',
  prExplainDescription: 'pr:explainDescription',
  // main -> renderer progress event for the agentic "Explain this PR" action
  prExplainProgress: 'pr:explainProgress',
  prExplainFileChange: 'pr:explainFileChange',
  prRefreshComments: 'pr:refreshComments',
  prGetAdoComments: 'pr:getAdoComments',
  prExplainAdoComment: 'pr:explainAdoComment',
  prGetCodeSnippet: 'pr:getCodeSnippet',
  prReplyToComment: 'pr:replyToComment',
  prGetChangedFiles: 'pr:getChangedFiles',
  prGetFileDiff: 'pr:getFileDiff',
  prFetchImage: 'pr:fetchImage',
  // main -> renderer progress event
  prReviewProgress: 'pr:reviewProgress',
  // main -> renderer event fired when a review finishes (or errors)
  prReviewDone: 'pr:reviewDone',

  // Findings
  findingSetStatus: 'finding:setStatus',
  findingExplain: 'finding:explain',
  findingGetCode: 'finding:getCode',
  findingDraftComment: 'finding:draftComment',
  findingRefineComment: 'finding:refineComment',
  findingUpdateComment: 'finding:updateComment',
  findingPostComment: 'finding:postComment',
  findingSetThreadStatus: 'finding:setThreadStatus',
  findingCheckResolved: 'finding:checkResolved',
  findingCreateFromChat: 'finding:createFromChat',
  findingCreateFromAdoComment: 'finding:createFromAdoComment',
  prChat: 'pr:chat',
  prChatHistory: 'pr:chatHistory',
  prChatClear: 'pr:chatClear',

  // Diagnostics
  logsOpen: 'logs:open'
} as const
