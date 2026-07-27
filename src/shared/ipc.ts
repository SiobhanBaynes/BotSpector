// IPC channel names shared between preload and main.

export const IPC = {
  // Settings
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
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

  // Agent instructions
  agentGetInstructions: 'agent:getInstructions',
  agentSaveInstructions: 'agent:saveInstructions',

  // Pull requests
  prList: 'pr:list',
  prListCached: 'pr:listCached',
  prGet: 'pr:get',
  prGetReview: 'pr:getReview',
  prGetReviewHistory: 'pr:getReviewHistory',
  prGetPostedComments: 'pr:getPostedComments',
  prSetReviewStatus: 'pr:setReviewStatus',
  prGetAdoDetails: 'pr:getAdoDetails',
  prSetVote: 'pr:setVote',
  prSetAdoStatus: 'pr:setAdoStatus',
  prSetDraft: 'pr:setDraft',
  prReview: 'pr:review',
  prExplainDescription: 'pr:explainDescription',
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
  prChat: 'pr:chat',
  prChatHistory: 'pr:chatHistory',
  prChatClear: 'pr:chatClear',

  // Diagnostics
  logsOpen: 'logs:open'
} as const
