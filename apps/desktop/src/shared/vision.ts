export interface VisionExplanation {
  available: boolean
  summary: string
}

export interface VisionProvider {
  explainImage(): Promise<VisionExplanation>
}

export const unavailableVision: VisionProvider = {
  async explainImage() {
    return {
      available: false,
      summary: "Cloud vision isn't connected, so I did not describe a picture."
    }
  }
}
