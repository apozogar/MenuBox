import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, LoginHistoryEntry } from '../../services/auth.service';

@Component({
  selector: 'app-activity-log',
  imports: [CommonModule, FormsModule],
  templateUrl: './activity-log.html',
  styleUrl: './activity-log.css',
})
export class ActivityLog implements OnInit {
  entries: LoginHistoryEntry[] = [];
  total = 0;
  loading = false;
  usernameFilter = '';
  pageSize = 50;
  offset = 0;

  constructor(private authService: AuthService) {}

  ngOnInit() {
    this.load();
  }

  async load() {
    this.loading = true;
    const result = await this.authService.getLoginHistory({
      username: this.usernameFilter.trim() || undefined,
      limit: this.pageSize,
      offset: this.offset,
    });
    this.entries = result.entries;
    this.total = result.total;
    this.loading = false;
  }

  search() {
    this.offset = 0;
    this.load();
  }

  nextPage() {
    if (this.offset + this.pageSize >= this.total) return;
    this.offset += this.pageSize;
    this.load();
  }

  prevPage() {
    if (this.offset === 0) return;
    this.offset = Math.max(0, this.offset - this.pageSize);
    this.load();
  }

  get pageLabel(): string {
    if (this.total === 0) return '0 de 0';
    const from = this.offset + 1;
    const to = Math.min(this.offset + this.pageSize, this.total);
    return `${from}-${to} de ${this.total}`;
  }
}
