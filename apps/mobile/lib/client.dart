import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
class ApiClient {
  static const base = String.fromEnvironment('API_URL', defaultValue: 'http://10.0.2.2:8080/api/v1');
  final storage = const FlutterSecureStorage();
  String? access;
  Future<void>? refreshing;
  Future<dynamic> call(String path, {String method = 'GET', Object? body, Map<String,String>? headers, bool retry = true}) async {
    final request = http.Request(method, Uri.parse('$base$path'));
    request.headers.addAll({if(body != null) 'Content-Type':'application/json', if(access != null) 'Authorization':'Bearer $access', ...?headers});
    if(body is List<int>) { request.bodyBytes = body; } else if(body != null) { request.body = jsonEncode(body); }
    final response = await http.Response.fromStream(await request.send());
    if(response.statusCode == 401 && retry) {
      refreshing ??= refresh().whenComplete(() => refreshing = null);
      await refreshing;
      return call(path, method:method, body:body, headers:headers, retry:false);
    }
    final data = jsonDecode(response.body);
    if(response.statusCode >= 400) throw Exception(data['error']?['message'] ?? 'Request failed');
    return data;
  }
  Future<void> login(String email, String password) async { final data = await call('/auth/login', method:'POST', body:{'email':email,'password':password},retry:false); await save(data); }
  Future<void> save(dynamic data) async { access = data['accessToken']; await storage.write(key:'refresh',value:data['refreshToken']); }
  Future<void> refresh() async {
    final token = await storage.read(key:'refresh'); if(token == null) throw Exception('Sign in required');
    final data = await call('/auth/refresh',method:'POST',body:{'refreshToken':token},retry:false); await save(data);
  }
  Future<void> logout() async { try { await call('/auth/logout',method:'POST'); } finally {access=null;await storage.delete(key:'refresh');} }
}
