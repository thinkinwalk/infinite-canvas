package model

// ModelManagement is the single writable catalog. Public catalogs are derived.
type ModelManagement struct {
	Enabled  bool             `json:"enabled"`
	Revision int              `json:"revision"`
	Routes   []ManagedRoute   `json:"routes"`
	Models   []ManagedModel   `json:"models"`
	Bindings []FeatureBinding `json:"bindings"`
}

type ManagedRoute struct {
	ID         string             `json:"id"`
	ChannelID  int                `json:"channelId"`
	Model      string             `json:"model"`
	Version    string             `json:"version,omitempty"`
	Adapter    string             `json:"adapter"`
	Capability string             `json:"capability"`
	Operations []string           `json:"operations"`
	Enabled    bool               `json:"enabled"`
	Video      *VideoModelProfile `json:"video,omitempty"`
}

type ManagedModel struct {
	ID           string         `json:"id"`
	InternalName string         `json:"internalName"`
	DisplayName  string         `json:"displayName"`
	DisplayMode  string         `json:"displayMode"`
	Description  string         `json:"description"`
	Enabled      bool           `json:"enabled"`
	RouteIDs     []string       `json:"routeIds"`
	Pricing      ManagedPricing `json:"pricing"`
}

type ManagedPricing struct {
	Configured bool               `json:"configured"`
	Free       bool               `json:"free"`
	Credits    int                `json:"credits"`
	Video      *VideoModelProfile `json:"video,omitempty"`
	Replicate  *ReplicatePricing  `json:"replicate,omitempty"`
}

type FeatureBinding struct {
	FeatureID   string   `json:"featureId"`
	ModelID     string   `json:"modelId"`
	RouteIDs    []string `json:"routeIds"`
	Enabled     bool     `json:"enabled"`
	Default     bool     `json:"default"`
	Order       int      `json:"order"`
	Resolutions []string `json:"resolutions,omitempty"`
	Seconds     []string `json:"seconds,omitempty"`
}

type ModelFeature struct {
	ID         string   `json:"id"`
	Module     string   `json:"module"`
	Label      string   `json:"label"`
	Capability string   `json:"capability"`
	Operations []string `json:"operations"`
}

type ManagedCatalog struct {
	Enabled  bool                  `json:"enabled"`
	Revision int                   `json:"revision"`
	Features []ModelFeature        `json:"features"`
	Models   []PublicManagedModel  `json:"models"`
	Bindings []PublicFeatureModels `json:"bindings"`
}

type PublicManagedModel struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Capability  string `json:"capability"`
}

type PublicFeatureModels struct {
	FeatureID  string             `json:"featureId"`
	ModelID    string             `json:"modelId"`
	Default    bool               `json:"default"`
	Order      int                `json:"order"`
	Available  bool               `json:"available"`
	Reason     string             `json:"reason,omitempty"`
	Operations []string           `json:"operations"`
	Adapter    string             `json:"adapter"`
	Video      *VideoModelProfile `json:"video,omitempty"`
	Credits    int                `json:"credits"`
}
