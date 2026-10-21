import { NextResponse, type NextRequest } from "next/server";

// Filtre optimiste : redirige vers /login en l'absence de cookie de session.
// La vérification réelle (session valide, compte actif, permissions) est faite côté serveur
// dans chaque page et chaque route API.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("iatrano_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/c/:path*", "/settings/:path*", "/admin/:path*"],
};
