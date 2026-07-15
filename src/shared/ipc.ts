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
  prGet: 'pr:get',
  prGetReview: 'pr:getReview',
  prReview: 'pr:review',
  prExplainDescription: 'pr:explainDescription',
  prRefreshComments: 'pr:refreshComments',
  prGetChangedFiles: 'pr:getChangedFiles',
  prGetFileDiff: 'pr:getFileDiff',
  // main -> renderer progress event
  prReviewProgress: 'pr:reviewProgress',

  // Findings
  findingSetStatus: 'finding:setStatus',
  findingExplain: 'finding:explain',
  findingGetCode: 'finding:getCode',
  findingDraftComment: 'finding:draftComment',
  findingRefineComment: 'finding:refineComment',
  findingUpdateComment: 'finding:updateComment',
  findingPostComment: 'finding:postComment',

  // Diagnostics
  logsOpen: 'logs:open'
} as const
