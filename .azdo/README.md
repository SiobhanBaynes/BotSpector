# Azure Pipelines

`ci-pr.yml` installs dependencies, runs unit tests, publishes their results,
typechecks the application, and creates a production build on Ubuntu with
Node.js 24.

## Enable PR validation

Azure Repos Git uses a branch policy for pull-request validation rather than a
YAML `pr` trigger:

1. In **Pipelines**, create a pipeline from the existing
   `.azdo/ci-pr.yml` file.
2. In **Repos > Branches**, open the branch policies for `main`.
3. Add the pipeline under **Build validation** and make it automatic and
   required.

The YAML CI trigger also runs the pipeline after changes are merged or pushed
directly to `main`.