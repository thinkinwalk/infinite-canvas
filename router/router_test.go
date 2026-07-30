package router

import "testing"

func TestCreditLogAdminRoutesAreReadOnly(t *testing.T) {
	routes := New().Routes()
	foundRead := false
	for _, route := range routes {
		if route.Path == "/api/admin/credit-logs" && route.Method == "GET" {
			foundRead = true
		}
		if route.Path == "/api/admin/credit-logs" && route.Method == "POST" {
			t.Fatal("admin credit logs must not expose a create/update route")
		}
		if route.Path == "/api/admin/credit-logs/:id" && route.Method == "DELETE" {
			t.Fatal("admin credit logs must not expose a delete route")
		}
	}
	if !foundRead {
		t.Fatal("admin credit log read route is missing")
	}
}
